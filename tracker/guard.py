"""Kill switch: stop fetching when a data source pushes back or someone makes contact.

Halts are recorded in state/halt.json and persist across runs until removed by hand:
  - "bazaar": tibia.com challenged, refused or rate-limited us
  - "houses": TibiaData refused or rate-limited us
  - "all":    someone other than the owner opened an issue on the repo (the contact
              address advertised in the User-Agent). They get one automatic reply.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Set

import httpx

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
REPLY_FILE = ROOT / ".github" / "AUTO_REPLY.md"
SOURCES = ("houses", "bazaar")
BLOCK_STATUSES = (401, 403, 429)


class Blocked(RuntimeError):
    """A data source refused, challenged or rate-limited us. Never retried."""


def is_challenge(resp: httpx.Response) -> bool:
    """Detects a Cloudflare bot challenge, which can come with any status code."""
    if resp.headers.get("cf-mitigated") == "challenge":
        return True
    head = resp.text[:3000]
    return "<title>Just a moment...</title>" in head or "challenges.cloudflare.com" in head


def check_response(resp: httpx.Response, name: str) -> None:
    if is_challenge(resp):
        raise Blocked(f"{name} served a bot challenge (HTTP {resp.status_code})")
    if resp.status_code in BLOCK_STATUSES:
        raise Blocked(f"{name} answered HTTP {resp.status_code}")


def load(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def save(path: Path, halt: dict) -> None:
    if not halt:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(halt, indent=2, sort_keys=True) + "\n")


def stop(halt: dict, source: str, reason: str, now: datetime) -> bool:
    """Records a halt; returns False if that source was already halted."""
    if source in halt:
        return False
    halt[source] = {"reason": reason, "at": now.isoformat()}
    return True


def halted_sources(halt: dict) -> Set[str]:
    if "all" in halt:
        return set(SOURCES)
    return {s for s in SOURCES if s in halt}


def check_contact(
    halt: dict, replied: List[int], now: datetime, dry_run: bool, client: Optional[httpx.Client] = None
) -> List[dict]:
    """Halts everything if anyone but the owner has an open issue; replies once to each.

    `replied` (kept in seen.json so it survives resuming) is updated in place.
    Returns the issues that were new in this run. Only works inside GitHub Actions
    (needs GITHUB_REPOSITORY and GITHUB_TOKEN); skipped elsewhere.
    """
    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not (repo and token):
        log.info("Not running in GitHub Actions, skipping contact check")
        return []
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER") or repo.split("/")[0]
    own_client = client is None
    client = client or httpx.Client(
        base_url="https://api.github.com",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        timeout=30,
    )
    try:
        resp = client.get(f"/repos/{repo}/issues", params={"state": "open", "per_page": 100})
        resp.raise_for_status()
        external = [
            i for i in resp.json()
            if i["user"]["login"].lower() != owner.lower() and i["user"].get("type") != "Bot"
        ]
        if not external:
            return []
        first = external[0]
        stop(halt, "all", f"Contact on GitHub: #{first['number']} by {first['user']['login']}", now)
        new = [i for i in external if i["number"] not in replied]
        body = REPLY_FILE.read_text()
        for issue in new:
            if dry_run:
                log.info("Dry run: would auto-reply to #%s", issue["number"])
                continue
            client.post(f"/repos/{repo}/issues/{issue['number']}/comments", json={"body": body}).raise_for_status()
            replied.append(issue["number"])
            log.warning("Auto-replied to #%s by %s; all fetching halted", issue["number"], issue["user"]["login"])
        return new
    finally:
        if own_client:
            client.close()
