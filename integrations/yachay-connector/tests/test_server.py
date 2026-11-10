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
                "list_systems", "select_system", "get_system_context", "send_instruction", "respond_to_system",
            }
