"""A FAKE destination agent used ONLY for connector demonstrations.

It never touches a real POS, products, prices, customers, or databases.
Start via: uvicorn demo.mock_system:app --host 127.0.0.1 --port 9100
"""
import os
import secrets
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="POS simulated agent (no sales)")


class Instruction(BaseModel):
    protocol: str
    type: str
    request_id: str
    input: dict[str, Any]
    operation_id: str | None = None


def authorize(authorization: str | None):
    expected = os.getenv("POS_AGENT_TOKEN", "")
    if not expected or not authorization or not secrets.compare_digest(authorization, "Bearer " + expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/api/agent/context")
async def prepared_context(authorization: str | None = Header(None)):
    authorize(authorization)
    return {
        "system_id": "pos", "version": "demo-1", "context": {
            "description": "POS simulado para validar el conector. No registra ventas.",
            "instructions": [
                "Solicita una orden y transmítela completa al agente del POS.",
                "Comunica las respuestas sin inventar resultados.",
                "Cada orden de venta queda como venta por confirmar en esta simulación."
            ],
            "capabilities": ["simulate_sale", "simulate_confirmation"],
            "locale": "es-PE"
        }
    }


@app.post("/api/agent/instructions")
async def instructions(body: Instruction, authorization: str | None = Header(None)):
    authorize(authorization)
    if body.type == "instruction":
        return {"status": "pending_review", "operation_id": "demo-" + body.request_id,
                "message": "SIMULACIÓN: venta por confirmar; no se registró nada. Responde con el dato faltante o «cancelar»."}
    if body.type == "follow_up":
        answer = str(body.input.get("text", "")).strip().lower()
        if answer not in {"no", "cancelar", "cancela"}:
            return {"status": "completed", "message": "Simulación completada, SIN venta real.", "simulated": True}
        return {"status": "rejected", "message": "Simulación cancelada, SIN venta real.", "simulated": True}
    raise HTTPException(status_code=400, detail="type inválido")
