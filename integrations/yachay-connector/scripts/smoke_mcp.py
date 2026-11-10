"""Validate MCP; optional preparation always cancels and never confirms a sale."""
from __future__ import annotations

import asyncio
import argparse
import json
import os
import uuid

import httpx

from run_local import load_local_env


def tool_data(result: dict) -> dict:
    if result.get("isError"):
        raise RuntimeError("La herramienta MCP devolvió un error")
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    for part in result.get("content", []):
        if part.get("type") == "text":
            data = json.loads(part["text"])
            if isinstance(data, dict):
                return data
    raise RuntimeError("La herramienta no devolvió un objeto JSON")


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-relay", action="store_true", help="También consulta una operación inexistente; no envía una venta")
    parser.add_argument("--prepare-instruction", help="Prueba una preparación real con IA y cancela el borrador; nunca confirma")
    options = parser.parse_args()
    load_local_env()
    port = os.environ.get("YACHAY_PORT", "8000")
    url = f"http://127.0.0.1:{port}/mcp"
    headers = {
        "x-yachay-connector-key": os.environ["YACHAY_MCP_KEY"],
        "Accept": "application/json, text/event-stream",
    }
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        unauthorized = await client.post(url, json={})
        assert unauthorized.status_code == 401, "El MCP debe requerir credencial"

        async def rpc(number: int, method: str, params: dict | None = None) -> dict:
            payload = {"jsonrpc": "2.0", "id": number, "method": method}
            if params is not None:
                payload["params"] = params
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
            if "error" in data:
                raise RuntimeError("El protocolo MCP devolvió un error")
            return data["result"]

        init = await rpc(1, "initialize", {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "yachay-local-validation", "version": "1.0"},
        })
        headers["MCP-Protocol-Version"] = init["protocolVersion"]
        ready = await client.post(url, headers=headers, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })
        ready.raise_for_status()
        listed = await rpc(2, "tools/list")
        names = {tool["name"] for tool in listed["tools"]}
        expected = {"list_systems", "select_system", "get_system_context", "send_instruction", "respond_to_system"}
        assert expected <= names, "Faltan herramientas del contrato"
        systems = tool_data(await rpc(3, "tools/call", {"name": "list_systems", "arguments": {}}))
        assert any(system["id"] == "pos" for system in systems["systems"])
        selected = tool_data(await rpc(4, "tools/call", {
            "name": "select_system", "arguments": {"system_id": "pos"},
        }))
        assert selected.get("status") == "selected", "No se pudo seleccionar el POS"
        assert selected["prepared_context"]["system_id"] == "pos"
        refreshed = tool_data(await rpc(5, "tools/call", {
            "name": "get_system_context", "arguments": {"selection_token": selected["selection_token"]},
        }))
        assert refreshed["prepared_context"]["system_id"] == "pos"
        relay_status = None
        if options.check_relay:
            relayed = tool_data(await rpc(6, "tools/call", {
                "name": "respond_to_system", "arguments": {
                    "selection_token": selected["selection_token"],
                    "operation_id": str(uuid.uuid4()), "answer": "consultar operación inexistente",
                    "request_id": str(uuid.uuid4()),
                },
            }))
            relay_status = relayed["system_response"]["status"]
            assert relay_status == "rejected", "El POS debe rechazar una operación inexistente"
        preparation_status = None
        cancellation_status = None
        if options.prepare_instruction:
            request_id = str(uuid.uuid4())
            arguments = {"selection_token": selected["selection_token"], "instruction": options.prepare_instruction, "request_id": request_id}
            prepared = None
            for attempt in range(12):
                prepared = tool_data(await rpc(10 + attempt, "tools/call", {"name": "send_instruction", "arguments": arguments}))
                preparation_status = prepared["system_response"]["status"]
                if preparation_status != "pending":
                    break
                await asyncio.sleep(3)
            assert preparation_status in {"requires_confirmation", "needs_clarification"}, "La preparación no devolvió un borrador pendiente"
            cancelled = tool_data(await rpc(30, "tools/call", {
                "name": "respond_to_system", "arguments": {
                    "selection_token": selected["selection_token"],
                    "operation_id": prepared["system_response"]["operation_id"],
                    "answer": "cancelar", "request_id": str(uuid.uuid4()),
                },
            }))
            cancellation_status = cancelled["system_response"]["status"]
            assert cancellation_status == "rejected", "La cancelación debe cerrar el borrador sin ejecutar la venta"
        print(json.dumps({
            "endpoint": url, "unauthorized_status": unauthorized.status_code,
            "server": init["serverInfo"]["name"], "protocol_version": init["protocolVersion"],
            "tools": sorted(names), "selected_system": selected["active_system"],
            "context_refreshed": True, "sales_executed": 0,
            "unknown_operation_status": relay_status,
            "preparation_status": preparation_status, "cancellation_status": cancellation_status,
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
