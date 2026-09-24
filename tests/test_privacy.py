from pathlib import Path

import pytest
import yaml
from cryptography.fernet import Fernet, InvalidToken

from tracker import state as st
from tracker.config import load_config

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def template(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump({
        "user_agent": "ua",
        "houses": {"world": "Antica", "towns": ["Thais"]},
        "bazaar": {"high_skill": {"KNIGHT": {"SWORD_FIGHTING": 115}, "PALADIN": {"DISTANCE_FIGHTING": 115}}},
    }))
    return path


def test_env_override_replaces_whole_sections(template, monkeypatch):
    monkeypatch.setenv("TRACKER_CONFIG", "bazaar:\n  high_skill:\n    PALADIN: {DISTANCE_FIGHTING: 140}\n")
    cfg = load_config(template)
    assert cfg["bazaar"]["high_skill"] == {"PALADIN": {"DISTANCE_FIGHTING": 140}}  # knight gone
    assert cfg["houses"]["world"] == "Antica" and cfg["user_agent"] == "ua"


def test_local_file_then_env(template, monkeypatch):
    template.with_name("config.local.yaml").write_text("houses: {world: Secretia, towns: [A]}\n")
    monkeypatch.delenv("TRACKER_CONFIG", raising=False)
    assert load_config(template)["houses"]["world"] == "Secretia"
    monkeypatch.setenv("TRACKER_CONFIG", "houses: {world: Other, towns: [B]}\n")
    assert load_config(template)["houses"]["world"] == "Other"


def test_encrypted_state_roundtrip_and_unreadable(tmp_path):
    key = Fernet.generate_key().decode()
    path = st.path_for(tmp_path, key)
    assert path.name == "seen.json.enc"
    state = st.load(path, key)
    state["auctions"]["123"] = {"name": "Secret Paladin"}
    st.save(path, state, key)
    assert b"Secret Paladin" not in path.read_bytes()
    assert st.load(path, key)["auctions"]["123"]["name"] == "Secret Paladin"
    with pytest.raises(InvalidToken):
        st.load(path, Fernet.generate_key().decode())


def test_unchanged_state_is_not_rewritten(tmp_path):
    key = Fernet.generate_key().decode()
    path = st.path_for(tmp_path, key)
    st.save(path, st.load(path, key), key)
    before = path.read_bytes()
    st.save(path, st.load(path, key), key)
    assert path.read_bytes() == before  # no spurious commit every run


def test_public_template_does_not_leak_private_config():
    local = ROOT / "config.local.yaml"
    if not local.exists():
        pytest.skip("no private config on this machine")
    private = yaml.safe_load(local.read_text())
    public = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert public["houses"]["world"] != private["houses"]["world"]
    assert public["bazaar"]["high_skill"] != private["bazaar"]["high_skill"]
