import json
import os
from pathlib import Path

import httpx
import pytest

from yachay_connector.connector import Connector
from yachay_connector.registry import load_registry
from yachay_connector.selection import SelectionSigner


@pytest.fixture
def connector(monkeypatch):
    monkeypatch.setenv("POS_AGENT_TOKEN", "test-token-not-a-production-secret")
    systems = load_registry(Path(__file__).parents[1] / "systems.json")
    seen = []

    def handle(req: httpx.Request):
        seen.append(req)
        if req.headers.get("authorization") != "Bearer test-token-not-a-production-secret":
            return httpx.Response(401, json={"error": "not authorized"})
        if req.method == "GET" and req.url.path == "/api/agent/context":
            return httpx.Response(200, json={
                "system_id": "pos", "version": "1",
                "context": {
                    "description": "El POS recibe instrucciones, prepara y ejecuta ventas",
                    "instructions": ["No decidas los precios; consulta al POS"],
                    "capabilities": ["sales", "inventory"]
                }
            })
        if req.method == "POST" and req.url.path == "/api/agent/instructions":
            body = json.loads(req.content)
            if body["type"] == "instruction":
                return httpx.Response(200, json={"status": "requires_confirmation", "operation_id": "op-123", "message": "¿Confirmas?"})
            return httpx.Response(200, json={"status": "completed", "message": "Ejecutado por POS"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    yield Connector(systems, SelectionSigner("a" * 48), client), seen
