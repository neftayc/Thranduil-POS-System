import json
import uuid

import httpx
import pytest

from yachay_connector.connector import ConnectorError


@pytest.mark.asyncio
async def test_list_systems_only_enabled(connector):
    service, _ = connector
    assert [x["id"] for x in service.list_systems()["systems"]] == ["pos"]


@pytest.mark.asyncio
async def test_selection_loads_prepared_context(connector):
    service, seen = connector
    result = await service.select_system("pos")
    assert result["status"] == "selected"
    assert result["prepared_context"]["context"]["capabilities"] == ["sales", "inventory"]
    assert result["active_system"] == "pos"
    assert seen[0].method == "GET"
    assert "selection_token" in result


@pytest.mark.asyncio
async def test_instructions_forwarded_as_is_without_price_logic(connector):
    service, seen = connector
    token = (await service.select_system("pos"))["selection_token"]
    phrase = "vende el cuaderno amarillo A4 de 100 hojas"
    rid = str(uuid.uuid4())
    result = await service.send_instruction(token, phrase, rid)
    request = json.loads(seen[-1].content)
    assert request["input"]["text"] == phrase
    assert request["type"] == "instruction"
    assert request["request_id"] == rid
    assert "items" not in request
    assert result["system_response"]["status"] == "requires_confirmation"


@pytest.mark.asyncio
async def test_follow_up_only_relays_confirmation(connector):
    service, seen = connector
    token = (await service.select_system("pos"))["selection_token"]
    r = await service.respond_to_system(token, "op-123", "sí", str(uuid.uuid4()))
    body = json.loads(seen[-1].content)
    assert body["type"] == "follow_up"
    assert body["operation_id"] == "op-123"
    assert r["system_response"]["status"] == "completed"


@pytest.mark.asyncio
async def test_tokens_are_distinct_and_conversation_independent(connector):
    service, _ = connector
    a = await service.select_system("pos")
    b = await service.select_system("pos")
    assert a["selection_token"] != b["selection_token"]
    assert service.signer.verify(a["selection_token"]).system == "pos"


@pytest.mark.asyncio
async def test_disabled_system_denied(connector):
    service, _ = connector
    with pytest.raises(ConnectorError):
        await service.select_system("pms")


@pytest.mark.asyncio
async def test_invalid_token_denied(connector):
    service, _ = connector
    with pytest.raises(ConnectorError):
        await service.send_instruction("fake", "vende uno", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_invalid_uuid_denied(connector):
    service, _ = connector
    token = (await service.select_system("pos"))["selection_token"]
    with pytest.raises(ConnectorError, match="UUID"):
        await service.send_instruction(token, "vende uno", "different-random-value")


@pytest.mark.asyncio
async def test_refresh_context(connector):
    service, seen = connector
    token = (await service.select_system("pos"))["selection_token"]
    result = await service.get_system_context(token)
    assert result["active_system"] == "pos"
    assert [r.method for r in seen] == ["GET", "GET"]


@pytest.mark.asyncio
async def test_network_failure_does_not_claim_success(connector):
    service, _ = connector
    token = (await service.select_system("pos"))["selection_token"]
    async def fail(req):
        raise httpx.ReadTimeout("timeout")
    service.client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    with pytest.raises(ConnectorError, match="No asumir"):
        await service.send_instruction(token, "vende uno", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_invalid_destination_response_rejected(connector):
    service, _ = connector
    token = (await service.select_system("pos"))["selection_token"]
    service.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"status":"invented"})))
    with pytest.raises(ConnectorError, match="no reconocido"):
        await service.send_instruction(token, "vende uno", str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_missing_service_secret_rejected(connector, monkeypatch):
    service, _ = connector
    monkeypatch.delenv("POS_AGENT_TOKEN")
    with pytest.raises(ConnectorError, match="credencial"):
        await service.select_system("pos")
