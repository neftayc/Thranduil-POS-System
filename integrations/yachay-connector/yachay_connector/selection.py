"""Encrypted stateless selection token. No database, no password, no business data.

The token binds a conversation to one system and, when the system requires seller
identification, to the opaque seller-session reference issued by THAT system. It is
encrypted (AES-256-GCM) so the reference is not readable in the conversation, and
authenticated so it cannot be altered or moved to another system.

States:
- ``open``: the system does not require identification (demo or legacy systems).
- ``pending``: identification started; ``ref`` is the system's identification handle.
- ``active``: identification approved; ``ref`` is the system's seller-session reference.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STATES = {"open", "pending", "active"}
MAX_REF = 512
VERSION = 2
INVALID = "Selección inválida; vuelve a seleccionar el sistema"


class SelectionError(ValueError):
    pass


@dataclass(frozen=True)
class Selection:
    system: str
    state: str
    ref: str | None
    expires_at: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class SelectionSigner:
    def __init__(self, key: str, ttl_seconds: int = 3600):
        if len(key.encode("utf-8")) < 32:
            raise ValueError("YACHAY_SIGNING_KEY debe tener al menos 32 bytes")
        if not 60 <= ttl_seconds <= 86400:
            raise ValueError("TTL fuera del rango permitido")
        self._aead = AESGCM(hashlib.sha256(b"yachay-selection/2|" + key.encode("utf-8")).digest())
        self.ttl = ttl_seconds

    def issue(self, system_id: str, state: str = "open", ref: str | None = None,
              ttl_seconds: int | None = None) -> tuple[str, int]:
        if state not in STATES:
            raise ValueError("Estado de selección inválido")
        if (state == "open") != (ref is None):
            raise ValueError("Referencia de selección incoherente")
        if ref is not None and (not isinstance(ref, str) or not 1 <= len(ref) <= MAX_REF):
            raise ValueError("Referencia de selección inválida")
        ttl = self.ttl if ttl_seconds is None else int(ttl_seconds)
        if not 60 <= ttl <= 86400:
            raise ValueError("TTL fuera del rango permitido")
        expiry = int(time.time()) + ttl
        payload = {"v": VERSION, "sys": system_id, "st": state, "ref": ref, "exp": expiry, "n": secrets.token_hex(8)}
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, json.dumps(payload, separators=(",", ":")).encode("utf-8"), b"yachay")
        return _b64(nonce + sealed), expiry

    def verify(self, token: str) -> Selection:
        if not isinstance(token, str) or not 40 <= len(token) <= 1400:
            raise SelectionError(INVALID)
        try:
            raw = _unb64(token)
            body = json.loads(self._aead.decrypt(raw[:12], raw[12:], b"yachay"))
        except (InvalidTag, ValueError, UnicodeDecodeError, json.JSONDecodeError) as err:
            raise SelectionError(INVALID) from err
        try:
            if body["v"] != VERSION or not isinstance(body["sys"], str) or body["st"] not in STATES:
                raise SelectionError(INVALID)
            if int(body["exp"]) < int(time.time()):
                raise SelectionError("Selección vencida; vuelve a seleccionar el sistema")
            ref = body["ref"]
            if (body["st"] == "open") != (ref is None):
                raise SelectionError(INVALID)
            return Selection(body["sys"], body["st"], ref, int(body["exp"]))
        except SelectionError:
            raise
        except (KeyError, TypeError, ValueError) as err:
            raise SelectionError(INVALID) from err
