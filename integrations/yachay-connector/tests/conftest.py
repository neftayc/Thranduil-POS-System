import dataclasses
import json
import os
import time
from pathlib import Path

import httpx
import pytest

from yachay_connector.connector import Connector
from yachay_connector.registry import load_registry
from yachay_connector.selection import SelectionSigner


@pytest.fixture
def connector(monkeypatch):
    monkeypatch.setenv("POS_AGENT_TOKEN", "test-token-not-a-production-secret")
    # Legacy "open" mode: a system without identification_url (demo systems).
    systems = {k: dataclasses.replace(v, identification_url=None)
               for k, v in load_registry(Path(__file__).parents[1] / "systems.json").items()}
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
                return httpx.Response(200, json={"status": "pending_review", "operation_id": "op-123", "message": "Venta por confirmar"})
            return httpx.Response(200, json={"status": "completed", "message": "Ejecutado por POS"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    yield Connector(systems, SelectionSigner("a" * 48), client), seen


CONTEXT = {
    "system_id": "pos", "version": "1",
    "context": {
        "description": "POS", "instructions": ["Envía el pedido literal"], "capabilities": ["sales"],
    },
}
SESSIONS = {
    "sess-ana": {"user": "ana", "valid": True},
    "sess-beto": {"user": "beto", "valid": True},
    "sess-sinrol": {"user": "carla", "valid": False, "message": "Tu usuario no tiene un rol de vendedor válido en el POS. No se registró ninguna venta."},
}


class FakePOS:
    """Mock system implementing yachay-identification/1 and seller-bound operations."""

    def __init__(self):
        self.seen: list[httpx.Request] = []
        self.identification = {"status": "pending", "session": "sess-ana", "name": "Ana Pérez", "role": "cashier", "ttl": 8 * 3600}
        self.start_override: dict | None = None
        self.operations: dict[str, str] = {}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.seen.append(req)
        if req.headers.get("authorization") != "Bearer test-token-not-a-production-secret":
            return httpx.Response(401, json={"statusMessage": "Credencial del conector inválida"})
        session = req.headers.get("x-yachay-session")
        if req.url.path == "/api/agent/identification":
            body = json.loads(req.content)
            assert body["protocol"] == "yachay-identification/1"
            if body["action"] == "start":
                return httpx.Response(200, json=self.start_override or {
                    "status": "requires_identification", "identification_id": "ident-secret-handle",
                    "user_code": "K7M-42Q", "verification_url": "http://127.0.0.1:3000/vincular",
                    "expires_in": 600,
                })
            assert body["identification_id"] == "ident-secret-handle"
            state = self.identification
            if state["status"] != "approved":
                return httpx.Response(200, json={"status": state["status"]})
            return httpx.Response(200, json={
                "status": "approved", "session": state["session"],
                "seller": {"name": state["name"], "role": state["role"]},
                "expires_at": int(time.time()) + state["ttl"],
            })
        if session is not None:
            info = SESSIONS.get(session)
            if not info or not info["valid"]:
                return httpx.Response(403, json={"statusMessage": (info or {}).get("message") or "Sesión de vendedor inválida, vencida o revocada."})
        if req.method == "GET" and req.url.path == "/api/agent/context":
            return httpx.Response(200, json=CONTEXT)
        if req.method == "POST" and req.url.path == "/api/agent/instructions":
            if session is None:
                return httpx.Response(403, json={"statusMessage": "Falta la sesión del vendedor."})
            body = json.loads(req.content)
            user = SESSIONS[session]["user"]
            if body["type"] == "instruction":
                op = f"op-{len(self.operations) + 1}"
                self.operations[op] = user
                return httpx.Response(200, json={"status": "completed", "operation_id": op, "message": "Venta registrada", "result": {"reference": "sale-1"}})
            owner = self.operations.get(body["operation_id"])
            if owner != user:
                return httpx.Response(403, json={"statusMessage": "Esta operación pertenece a otro vendedor."})
            return httpx.Response(200, json={"status": "pending_review", "operation_id": body["operation_id"], "message": "Venta por confirmar"})
        return httpx.Response(404)


@pytest.fixture
def pos_identified(monkeypatch):
    monkeypatch.setenv("POS_AGENT_TOKEN", "test-token-not-a-production-secret")
    systems = load_registry(Path(__file__).parents[1] / "systems.json")
    assert systems["pos"].requires_identification
    fake = FakePOS()
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    yield Connector(systems, SelectionSigner("b" * 48), client), fake
