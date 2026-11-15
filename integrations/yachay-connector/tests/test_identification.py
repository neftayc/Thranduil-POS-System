"""Seller identification relay: link + code approved on the system, session bound to the token."""
import time
import uuid

import pytest

from yachay_connector.connector import ConnectorError, SystemRejected
from yachay_connector.selection import SelectionSigner


async def identify(service, fake, session="sess-ana"):
    started = await service.select_system("pos")
    fake.identification.update(status="approved", session=session)
    return await service.check_identification(started["selection_token"], "472")


def instruction_calls(fake):
    return [r for r in fake.seen if r.url.path == "/api/agent/instructions"]


@pytest.mark.asyncio
async def test_select_requires_identification_and_never_asks_password(pos_identified):
    service, fake = pos_identified
    started = await service.select_system("pos")
    assert started["status"] == "requires_identification"
    assert started["user_code"] == "K7M-42Q"
    assert started["verification_url"] == "http://127.0.0.1:3000/vincular"
    assert "contraseña" in started["message"] and "Nunca" in started["message"]
    assert "ident-secret-handle" not in started["selection_token"]
    assert "prepared_context" not in started


@pytest.mark.asyncio
async def test_pending_token_cannot_send_instructions(pos_identified):
    service, fake = pos_identified
    token = (await service.select_system("pos"))["selection_token"]
    with pytest.raises(ConnectorError, match="Falta identificar"):
        await service.send_instruction(token, "vende un lápiz", str(uuid.uuid4()))
    with pytest.raises(ConnectorError, match="Falta identificar"):
        await service.get_system_context(token)
    assert instruction_calls(fake) == []


@pytest.mark.asyncio
async def test_check_identification_pending_then_approved(pos_identified):
    service, fake = pos_identified
    token = (await service.select_system("pos"))["selection_token"]
    assert (await service.check_identification(token))["status"] == "pending_identification"
    fake.identification["status"] = "approved"
    assert (await service.check_identification(token))["status"] == "requires_match"
    active = await service.check_identification(token, "472")
    assert active["status"] == "selected"
    assert active["seller"] == {"name": "Ana Pérez", "role": "cashier"}
    assert active["message"].startswith("Sesión activa como Ana Pérez (cashier).")
    assert "si no es él o ella" in active["message"]
    assert fake.seen[-2].read() and b'"match_code":"472"' in fake.seen[-2].content.replace(b" ", b"")
    assert active["prepared_context"]["system_id"] == "pos"
    assert "sess-ana" not in active["selection_token"]
    selection = service.signer.verify(active["selection_token"])
    assert (selection.state, selection.ref) == ("active", "sess-ana")


@pytest.mark.asyncio
async def test_active_token_forwards_seller_session(pos_identified):
    service, fake = pos_identified
    token = (await identify(service, fake))["selection_token"]
    result = await service.send_instruction(token, "vende un lápiz", str(uuid.uuid4()))
    assert result["system_response"]["status"] == "completed"
    assert instruction_calls(fake)[-1].headers["x-yachay-session"] == "sess-ana"
    assert instruction_calls(fake)[-1].headers["authorization"].startswith("Bearer ")


@pytest.mark.asyncio
async def test_operation_of_another_seller_is_rejected(pos_identified):
    service, fake = pos_identified
    ana = (await identify(service, fake, "sess-ana"))["selection_token"]
    beto = (await identify(service, fake, "sess-beto"))["selection_token"]
    op = (await service.send_instruction(ana, "vende un lápiz", str(uuid.uuid4())))["system_response"]["operation_id"]
    with pytest.raises(SystemRejected, match="otro vendedor"):
        await service.respond_to_system(beto, op, "cancelar", str(uuid.uuid4()))
    same = await service.respond_to_system(ana, op, "agrega un borrador", str(uuid.uuid4()))
    assert same["system_response"]["status"] == "pending_review"


@pytest.mark.asyncio
async def test_seller_without_role_or_revoked_is_rejected_in_spanish(pos_identified):
    service, fake = pos_identified
    # The POS refuses to approve a seller without role; if the role is removed later, the
    # POS rejects the session on every call and the connector relays the Spanish reason.
    signer = service.signer
    token, _ = signer.issue("pos", "active", "sess-sinrol", 3600)
    with pytest.raises(SystemRejected, match="rol de vendedor válido") as err:
        await service.send_instruction(token, "vende un lápiz", str(uuid.uuid4()))
    assert "sess-" not in str(err.value) and "Bearer" not in str(err.value)
    revoked, _ = signer.issue("pos", "active", "sess-revocada", 3600)
    with pytest.raises(SystemRejected, match="revocada"):
        await service.send_instruction(revoked, "vende un lápiz", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_token_without_seller_or_from_other_key_is_rejected(pos_identified):
    service, fake = pos_identified
    open_token, _ = service.signer.issue("pos")  # "open" selection: no seller
    with pytest.raises(ConnectorError, match="sin vendedor"):
        await service.send_instruction(open_token, "vende un lápiz", str(uuid.uuid4()))
    foreign, _ = SelectionSigner("c" * 48).issue("pos", "active", "sess-ana", 3600)
    with pytest.raises(ConnectorError, match="inválida"):
        await service.send_instruction(foreign, "vende un lápiz", str(uuid.uuid4()))
    with pytest.raises(ConnectorError, match="inválida"):
        await service.send_instruction("x" * 80, "vende un lápiz", str(uuid.uuid4()))
    assert instruction_calls(fake) == []


@pytest.mark.asyncio
async def test_expired_session_token_is_rejected(pos_identified, monkeypatch):
    service, fake = pos_identified
    now = int(time.time())
    fake.identification["ttl"] = 120
    token = (await identify(service, fake))["selection_token"]
    monkeypatch.setattr(time, "time", lambda: now + 181)
    with pytest.raises(ConnectorError, match="vencida"):
        await service.send_instruction(token, "vende un lápiz", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_expired_or_denied_code_requires_new_selection(pos_identified):
    service, fake = pos_identified
    token = (await service.select_system("pos"))["selection_token"]
    fake.identification["status"] = "expired"
    with pytest.raises(ConnectorError, match="venció"):
        await service.check_identification(token)
    fake.identification["status"] = "denied"
    with pytest.raises(ConnectorError, match="rechazado"):
        await service.check_identification(token)


@pytest.mark.asyncio
async def test_active_token_cannot_be_checked_again(pos_identified):
    service, fake = pos_identified
    token = (await identify(service, fake))["selection_token"]
    with pytest.raises(ConnectorError, match="ya está completa"):
        await service.check_identification(token)


@pytest.mark.asyncio
async def test_verification_link_must_belong_to_the_system(pos_identified):
    service, fake = pos_identified
    fake.start_override = {
        "status": "requires_identification", "identification_id": "ident-secret-handle",
        "user_code": "K7M-42Q", "verification_url": "https://phishing.example.com/vincular", "expires_in": 600,
    }
    with pytest.raises(ConnectorError, match="identificación inválida"):
        await service.select_system("pos")


@pytest.mark.asyncio
async def test_session_about_to_expire_is_not_accepted(pos_identified):
    service, fake = pos_identified
    fake.identification["ttl"] = 30
    with pytest.raises(ConnectorError, match="menos de un minuto"):
        await identify(service, fake)


@pytest.mark.asyncio
async def test_configured_public_origin_is_accepted_and_others_rejected(pos_identified):
    import dataclasses
    service, fake = pos_identified
    service.systems["pos"] = dataclasses.replace(service.systems["pos"], verification_origin="https://pos.ejemplo.pe")
    fake.start_override = {
        "status": "requires_identification", "identification_id": "ident-secret-handle",
        "user_code": "K7M-42Q", "verification_url": "https://pos.ejemplo.pe/vincular", "expires_in": 600,
    }
    assert (await service.select_system("pos"))["verification_url"] == "https://pos.ejemplo.pe/vincular"
    fake.start_override["verification_url"] = "https://otro.ejemplo.pe/vincular"
    with pytest.raises(ConnectorError, match="identificación inválida"):
        await service.select_system("pos")


@pytest.mark.asyncio
async def test_statuses_the_pos_never_returns_are_rejected(pos_identified):
    import httpx
    service, fake = pos_identified
    token = (await identify(service, fake))["selection_token"]
    for status in ("requires_confirmation", "needs_clarification"):
        service.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _req, s=status: httpx.Response(200, json={"status": s, "operation_id": "op-1"})))
        with pytest.raises(ConnectorError, match="no reconocido"):
            await service.send_instruction(token, "vende un lápiz", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_number_matching_is_required_and_never_guessed(pos_identified):
    service, fake = pos_identified
    token = (await service.select_system("pos"))["selection_token"]
    fake.identification["status"] = "approved"
    needs = await service.check_identification(token)
    assert needs["status"] == "requires_match"
    assert "Nunca lo inventes" in needs["message"]
    assert "selection_token" not in needs
    wrong = await service.check_identification(token, "111")
    assert wrong["status"] == "match_mismatch"
    assert "Quedan 2 intentos" in wrong["message"]
    with pytest.raises(ConnectorError, match="solo dígitos"):
        await service.check_identification(token, "abc")
    active = await service.check_identification(token, " 4 7 2 ")
    assert active["status"] == "selected"
    fake.identification["status"] = "denied"
    with pytest.raises(ConnectorError, match="no coincidió"):
        await service.check_identification((await service.select_system("pos"))["selection_token"], "999")
