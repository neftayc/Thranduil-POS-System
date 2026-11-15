"""Static allowlisted registry; the LLM cannot supply URLs or credentials."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ID = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


@dataclass(frozen=True)
class System:
    id: str
    name: str
    description: str
    aliases: tuple[str, ...]
    context_url: str
    instruction_url: str
    service_token_env: str
    identification_url: str | None = None
    # Public origin of the system's verification page when it differs from identification_url
    # (e.g. POS_AGENT_PUBLIC_URL). Only this origin or identification_url's is accepted.
    verification_origin: str | None = None

    @property
    def requires_identification(self) -> bool:
        return self.identification_url is not None

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "aliases": list(self.aliases),
            "requires_identification": self.requires_identification,
        }


def _valid_url(url: str) -> bool:
    try:
        p = urlsplit(url)
        if p.username or p.password or p.query or p.fragment or not p.hostname or not p.path:
            return False
        if p.scheme == "https":
            return True
        return p.scheme == "http" and p.hostname in {"127.0.0.1", "localhost", "::1"}
    except ValueError:
        return False


def _valid_origin(origin: str) -> bool:
    try:
        p = urlsplit(origin)
        if p.username or p.password or p.query or p.fragment or not p.hostname or p.path not in {"", "/"}:
            return False
        return p.scheme == "https" or (p.scheme == "http" and p.hostname in {"127.0.0.1", "localhost", "::1"})
    except ValueError:
        return False


def load_registry(path: str | Path) -> dict[str, System]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("systems"), list):
        raise ValueError("systems.json debe incluir una lista 'systems'")
    systems: dict[str, System] = {}
    for item in raw["systems"]:
        if not isinstance(item, dict):
            raise ValueError("Cada sistema debe ser un objeto")
        sid = str(item.get("id", ""))
        if not ID.fullmatch(sid) or sid in systems:
            raise ValueError(f"ID de sistema inválido o duplicado: {sid!r}")
        if item.get("enabled") is False:
            continue
        cu, iu = str(item.get("context_url", "")), str(item.get("instruction_url", ""))
        if not _valid_url(cu) or not _valid_url(iu):
            raise ValueError(f"URL insegura o inválida para {sid} (HTTPS externo obligatorio)")
        ident = item.get("identification_url")
        if ident is not None and (not isinstance(ident, str) or not _valid_url(ident)):
            raise ValueError(f"URL de identificación insegura o inválida para {sid}")
        vorigin = item.get("verification_origin")
        if vorigin is not None:
            if ident is None or not isinstance(vorigin, str) or not _valid_origin(vorigin):
                raise ValueError(f"verification_origin inválido para {sid} (origen HTTPS sin ruta; requiere identification_url)")
        env = str(item.get("service_token_env", ""))
        if not ENV_NAME.fullmatch(env):
            raise ValueError(f"Nombre de variable de credencial inválido para {sid}")
        aliases = item.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(x, str) or not x.strip() for x in aliases):
            raise ValueError(f"Aliases inválidos para {sid}")
        systems[sid] = System(
            sid, str(item.get("name", sid)), str(item.get("description", "")),
            tuple(aliases), cu, iu, env, ident, vorigin,
        )
    return systems
