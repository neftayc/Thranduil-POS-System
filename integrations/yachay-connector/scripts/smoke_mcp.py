"""Validate MCP and seller identification. NEVER sends a sale: the POS now registers
unambiguous orders directly, so this script only uses identification and an unknown follow-up."""
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
    parser.add_argument("--wait-identification", action="store_true", help="Muestra enlace y código y espera (máx. 10 min) a que un vendedor lo apruebe en el POS")
    parser.add_argument("--check-relay", action="store_true", help="Con --wait-identification: consulta una operación inexistente; no envía una venta")
    options = parser.parse_args()
    load_local_env()
    port = os.environ.get("YACHAY_PORT", "8000")
    url = f"http://127.0.0.1:{port}/mcp"
    headers = {"Accept": "application/json, text/event-stream"}
    dev_key = os.environ.get("YACHAY_MCP_KEY", "")
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        unauthorized_status = None
        if dev_key:
            unauthorized = await client.post(url, json={})
            unauthorized_status = unauthorized.status_code
            assert unauthorized_status == 401, "Con YACHAY_MCP_KEY el MCP debe requerir la clave de desarrollo"
            headers["x-yachay-connector-key"] = dev_key

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
        expected = {"list_systems", "select_system", "check_identification", "get_system_context", "send_instruction", "respond_to_system"}
        assert expected <= names, "Faltan herramientas del contrato"
        systems = tool_data(await rpc(3, "tools/call", {"name": "list_systems", "arguments": {}}))
        assert any(system["id"] == "pos" for system in systems["systems"])
        selected = tool_data(await rpc(4, "tools/call", {
            "name": "select_system", "arguments": {"system_id": "pos"},
        }))
        assert selected.get("status") == "requires_identification", "El POS debe pedir identificar al vendedor"
        token = selected["selection_token"]
        blocked = tool_data(await rpc(5, "tools/call", {
            "name": "send_instruction", "arguments": {
                "selection_token": token, "instruction": "prueba sin vendedor", "request_id": str(uuid.uuid4()),
            },
        }))
        assert blocked.get("status") == "error", "Sin vendedor identificado no se deben enviar instrucciones"
        checked = tool_data(await rpc(6, "tools/call", {"name": "check_identification", "arguments": {"selection_token": token}}))
        identification_status = checked.get("status")
        seller = None
        relay_status = None
        if options.wait_identification:
            print(f"Abre {selected['verification_url']} y aprueba el código {selected['user_code']} con tu usuario del POS.", flush=True)
            for attempt in range(120):
                if identification_status != "pending_identification":
                    break
                await asyncio.sleep(5)
                checked = tool_data(await rpc(100 + attempt, "tools/call", {"name": "check_identification", "arguments": {"selection_token": token}}))
                identification_status = checked.get("status")
            assert identification_status == "selected", "La identificación no se completó"
            seller = checked["seller"]
            token = checked["selection_token"]
            refreshed = tool_data(await rpc(300, "tools/call", {"name": "get_system_context", "arguments": {"selection_token": token}}))
            assert refreshed["prepared_context"]["context"]["seller"]["name"] == seller["name"]
            if options.check_relay:
                relayed = tool_data(await rpc(301, "tools/call", {
                    "name": "respond_to_system", "arguments": {
                        "selection_token": token, "operation_id": str(uuid.uuid4()),
                        "answer": "consultar operación inexistente", "request_id": str(uuid.uuid4()),
                    },
                }))
                relay_status = relayed["system_response"]["status"]
                assert relay_status == "rejected", "El POS debe rechazar una operación inexistente"
        print(json.dumps({
            "endpoint": url, "dev_key_enforced": unauthorized_status == 401,
            "server": init["serverInfo"]["name"], "protocol_version": init["protocolVersion"],
            "tools": sorted(names), "selected_system": selected["active_system"],
            "identification": identification_status, "seller": seller,
            "instruction_without_seller": "rechazada", "sales_executed": 0,
            "unknown_operation_status": relay_status,
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
