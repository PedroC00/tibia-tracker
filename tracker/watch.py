"""Watches for TibiaData's Char Bazaar endpoint (PR tibiadata/tibiadata-api-go#715).

tibia.com blocks cloud servers, so the bazaar can only run in GitHub Actions once
TibiaData (whose servers can reach tibia.com) serves it. Until then this makes one
cached request per run and announces the endpoint once when it goes live.
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

ENDPOINT = "https://api.tibiadata.com/v4/charactertrades/ending"
PR_URL = "https://github.com/tibiadata/tibiadata-api-go/pull/715"


def bazaar_endpoint_live(user_agent: str) -> bool:
    try:
        resp = httpx.get(ENDPOINT, headers={"User-Agent": user_agent}, timeout=30)
    except httpx.HTTPError as e:
        log.warning("TibiaData bazaar check failed: %s", type(e).__name__)
        return False
    return resp.status_code == 200
