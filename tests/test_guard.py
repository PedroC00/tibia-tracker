import json
import sys
from datetime import datetime, timezone

import httpx
import pytest

from tracker import __main__ as cli, guard

NOW = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)
CHALLENGE = '<html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>'


def resp(status=200, text="ok", headers=None):
    return httpx.Response(status, text=text, headers=headers or {})


@pytest.mark.parametrize("r", [
    resp(403, CHALLENGE),
    resp(200, CHALLENGE),
    resp(403, "", {"cf-mitigated": "challenge"}),
    resp(403, "Forbidden"),
    resp(429, "Too many requests"),
])
def test_blocking_responses_raise(r):
    with pytest.raises(guard.Blocked):
        guard.check_response(r, "tibia.com")


@pytest.mark.parametrize("r", [resp(200, "<html>bazaar</html>"), resp(503, "down"), resp(400, "bad town")])
def test_normal_responses_pass(r):
    guard.check_response(r, "tibia.com")


def test_halt_bookkeeping(tmp_path):
    halt = {}
    assert guard.stop(halt, "bazaar", "blocked", NOW)
    assert not guard.stop(halt, "bazaar", "again", NOW)  # first reason kept
    assert guard.halted_sources(halt) == {"bazaar"}
    guard.stop(halt, "all", "contact", NOW)
    assert guard.halted_sources(halt) == {"houses", "bazaar"}
    path = tmp_path / "halt.json"
    guard.save(path, halt)
    assert guard.load(path) == halt
    guard.save(path, {})
    assert not path.exists()


def issue(number, login, type_="User"):
    return {"number": number, "title": f"Issue {number}", "html_url": f"https://github.com/x/{number}",
            "user": {"login": login, "type": type_}}


def github_mock(issues, posted):
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=issues)
        posted.append((request.url.path, json.loads(request.content)["body"]))
        return httpx.Response(201, json={})
    return httpx.Client(base_url="https://api.github.com", transport=httpx.MockTransport(handler))


@pytest.fixture
def gh_env(monkeypatch):
    monkeypatch.setenv("GITHUB_REPOSITORY", "PedroC00/tibia-tracker")
    monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "PedroC00")
    monkeypatch.setenv("GITHUB_TOKEN", "t")


def test_contact_halts_everything_and_replies_once(gh_env):
    posted, halt, replied = [], {}, []
    issues = [issue(1, "PedroC00"), issue(2, "cipsoft-person"), issue(3, "dependabot", "Bot")]
    new = guard.check_contact(halt, replied, NOW, False, github_mock(issues, posted))
    assert [i["number"] for i in new] == [2]
    assert "all" in halt and "cipsoft-person" in halt["all"]["reason"]
    assert posted[0][0].endswith("/issues/2/comments") and "automatic reply" in posted[0][1]
    assert replied == [2]
    # Next run: still halted, no second reply
    assert guard.check_contact(halt, replied, NOW, False, github_mock(issues, posted)) == []
    assert len(posted) == 1


def test_owner_issues_do_not_halt(gh_env):
    halt = {}
    assert guard.check_contact(halt, [], NOW, False, github_mock([issue(1, "pedroc00")], [])) == []
    assert halt == {}


def test_contact_check_skipped_outside_actions(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert guard.check_contact({}, [], NOW, False) == []


def run_cli(monkeypatch, tmp_path, fetch_bazaar):
    sent = []
    monkeypatch.setenv("PUSHOVER_TOKEN", "t")
    monkeypatch.setenv("PUSHOVER_USER", "u")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("STATE_KEY", raising=False)
    monkeypatch.delenv("TRACKER_CONFIG", raising=False)
    monkeypatch.setattr(cli, "LOCAL_KEY_FILE", tmp_path / "no.key")
    monkeypatch.setattr(cli, "fetch_high_skill_auctions", fetch_bazaar)
    monkeypatch.setattr(cli.notify.Notifier, "send", lambda self, m: sent.append(m))
    monkeypatch.setattr(sys, "argv", ["tracker", "--only", "bazaar", "--state-dir", str(tmp_path)])
    code = cli.main()
    return code, sent


def test_blocked_bazaar_halts_and_stays_halted(monkeypatch, tmp_path):
    calls = []

    def blocked(cfg, ua):
        calls.append(1)
        raise guard.Blocked("tibia.com served a bot challenge (HTTP 403)")

    code, sent = run_cli(monkeypatch, tmp_path, blocked)
    assert code == 1 and len(calls) == 1
    assert len(sent) == 1 and sent[0].priority == 1 and "stopped" in sent[0].title
    assert "bazaar" in json.loads((tmp_path / "halt.json").read_text())

    code, sent = run_cli(monkeypatch, tmp_path, blocked)
    assert code == 0 and len(calls) == 1 and sent == []  # no request, no repeat alert

    (tmp_path / "halt.json").unlink()  # owner resumes
    run_cli(monkeypatch, tmp_path, blocked)
    assert len(calls) == 2
