import json
import time

import pytest

from yachay_connector.registry import load_registry
from yachay_connector.selection import SelectionError, SelectionSigner


def test_insecure_remote_endpoint_denied(tmp_path):
    doc={"systems":[{"id":"pos","name":"POS","enabled":True,"context_url":"http://example.com/api/agent/context","instruction_url":"https://example.com/api/agent/instructions","service_token_env":"POS_AGENT_TOKEN"}]}
    path=tmp_path / "systems.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="insegura"):
        load_registry(path)


def test_no_arbitrary_target_url(tmp_path):
    doc={"systems":[{"id":"pos","context_url":"http://127.0.0.1/x","instruction_url":"http://127.0.0.1/y","service_token_env":"POS_TOKEN","enabled":True},
                    {"id":"pos","context_url":"http://127.0.0.1/x","instruction_url":"http://127.0.0.1/y","service_token_env":"POS_TOKEN","enabled":True}]}
    path=tmp_path / "systems.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="duplicado"):
        load_registry(path)


def test_selection_rejects_tampering():
    signer=SelectionSigner("a"*48)
    token,_=signer.issue("pos")
    assert signer.verify(token)=="pos"
    with pytest.raises(SelectionError):
        signer.verify(token[:-2]+"11")


def test_selection_rejects_expiry(monkeypatch):
    signer=SelectionSigner("a"*48, ttl_seconds=60)
    before=int(time.time())
    monkeypatch.setattr(time, "time", lambda: before)
    token,_=signer.issue("pos")
    monkeypatch.setattr(time, "time", lambda: before+61)
    with pytest.raises(SelectionError, match="vencida"):
        signer.verify(token)


def test_too_short_signing_key_denied():
    with pytest.raises(ValueError):
        SelectionSigner("weak")
