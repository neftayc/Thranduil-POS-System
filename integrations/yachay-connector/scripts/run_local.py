"""Start the local connector with its private .env, without printing credentials."""
from __future__ import annotations

import os
from pathlib import Path


def load_local_env() -> Path:
    root = Path(__file__).resolve().parents[1]
    env_file = root / ".env"
    if not env_file.exists():
        raise SystemExit("Falta .env del conector. Completa .env.example antes de iniciar.")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise SystemExit("La configuración .env contiene una línea inválida")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    os.chdir(root)
    return root


if __name__ == "__main__":
    load_local_env()
    import uvicorn

    uvicorn.run(
        "yachay_connector.server:app",
        host=os.environ.get("YACHAY_HOST", "127.0.0.1"),
        port=int(os.environ.get("YACHAY_PORT", "8000")),
        workers=1,
    )
