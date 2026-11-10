"""Signed stateless system-selection token. No database, business session or user ID."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time


class SelectionError(ValueError):
    pass


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
        self.key = key.encode("utf-8")
        self.ttl = ttl_seconds

    def issue(self, system_id: str) -> tuple[str, int]:
        expiry = int(time.time()) + self.ttl
        payload = {"sys": system_id, "exp": expiry, "n": secrets.token_hex(16), "v": 1}
        encoded = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        mac = _b64(hmac.new(self.key, encoded.encode("ascii"), hashlib.sha256).digest())
        return encoded + "." + mac, expiry

    def verify(self, token: str) -> str:
        if not isinstance(token, str) or len(token) > 768 or token.count(".") != 1:
            raise SelectionError("Selección inválida; vuelve a seleccionar el sistema")
        encoded, mac = token.split(".")
        expected = _b64(hmac.new(self.key, encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(mac, expected):
            raise SelectionError("Selección inválida; vuelve a seleccionar el sistema")
        try:
            body = json.loads(_unb64(encoded))
            if body["v"] != 1 or not isinstance(body["sys"], str) or int(body["exp"]) < int(time.time()):
                raise SelectionError("Selección vencida; vuelve a seleccionar el sistema")
            return body["sys"]
        except SelectionError:
            raise
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as e:
            raise SelectionError("Selección inválida; vuelve a seleccionar el sistema") from e
