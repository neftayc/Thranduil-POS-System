"""Exercise the actual MCP ASGI transport without external services or sales."""
import importlib
import sys

import httpx
import pytest


@pytest.fixture
def server_app(monkeypatch):
    monkeypatch.setenv("YACHAY_SIGNING_KEY", "test-signing-" + "x" * 48)
    monkeypatch.setenv("YACHAY_MCP_KEY", "test-inbound-" + "x" * 48)
    monkeypatch.setenv("YACHAY_ALLOWED_HOSTS", "localhost:*,127.0.0.1:*")
    sys.modules.pop("yachay_connector.server", None)
    server = importlib.import_module("yachay_connector.server")
    return server.app


@pytest.mark.asyncio
async def test_mcp_transport_requires_header(server_app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server_app), base_url="http://127.0.0.1:8000") as client:
        response = await client.post("/mcp", json={})
        assert response.status_code == 401
        response = await client.post("/mcp", headers={"x-yachay-connector-key": "wrong"}, json={})
        assert response.status_code == 401


@pytest.mark.asyncio
async def test_mcp_transport_initializes_and_lists_tools(server_app):
    headers = {
        "x-yachay-connector-key": "test-inbound-" + "x" * 48,
        "Accept": "application/json, text/event-stream",
    }
    async with server_app.app.router.lifespan_context(server_app.app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server_app), base_url="http://127.0.0.1:8000", headers=headers) as client:
            initialized = await client.post("/mcp", json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-11-25", "capabilities": {},
                    "clientInfo": {"name": "test-client", "version": "1.0"},
                },
            })
            assert initialized.status_code == 200
            result = initialized.json()["result"]
            assert result["serverInfo"]["name"] == "Yachay Connector"
            client.headers["MCP-Protocol-Version"] = result["protocolVersion"]
            listed = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            assert listed.status_code == 200
            assert {tool["name"] for tool in listed.json()["result"]["tools"]} == {
                "list_systems", "select_system", "check_identification", "get_system_context",
                "send_instruction", "respond_to_system",
            }


def _reload(monkeypatch, **env):
    monkeypatch.setenv("YACHAY_SIGNING_KEY", "test-signing-" + "x" * 48)
    for key in ("YACHAY_MCP_KEY", "YACHAY_MODE", "YACHAY_HOST"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    sys.modules.pop("yachay_connector.server", None)
    return importlib.import_module("yachay_connector.server")


def test_only_explicit_local_mode_is_supported(monkeypatch):
    with pytest.raises(RuntimeError, match="modo local"):
        _reload(monkeypatch, YACHAY_MODE="remote")
    with pytest.raises(RuntimeError, match="127.0.0.1"):
        _reload(monkeypatch, YACHAY_HOST="0.0.0.0")
    with pytest.raises(RuntimeError, match="32"):
        _reload(monkeypatch, YACHAY_MCP_KEY="corta")


def test_missing_signing_key_fails_closed(monkeypatch):
    monkeypatch.setenv("YACHAY_SIGNING_KEY", "")
    sys.modules.pop("yachay_connector.server", None)
    with pytest.raises(ValueError):
        importlib.import_module("yachay_connector.server")


@pytest.mark.asyncio
async def test_development_header_is_optional_in_local_mode(monkeypatch):
    server = _reload(monkeypatch)
    app = server.app
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000",
                                     headers={"Accept": "application/json, text/event-stream"}) as client:
            response = await client.post("/mcp", json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-11-25", "capabilities": {},
                    "clientInfo": {"name": "test-client", "version": "1.0"},
                },
            })
            assert response.status_code == 200
