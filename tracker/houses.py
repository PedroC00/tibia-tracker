"""Auctioned houses from the TibiaData API (https://api.tibiadata.com)."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Iterable, List, Optional
from urllib.parse import quote

import httpx

from .guard import check_response

log = logging.getLogger(__name__)

API = "https://api.tibiadata.com/v4/houses/{world}/{town}"
TOWN_NOT_FOUND = 11006


@dataclass
class House:
    id: int
    name: str
    town: str
    world: str
    size: int
    rent: int
    bid: int
    time_left: str
    guildhall: bool

    @property
    def url(self) -> str:
        return (
            "https://www.tibia.com/community/?subtopic=houses&page=view"
            f"&world={quote(self.world)}&houseid={self.id}"
        )


def parse_houses(payload: dict, world: str, town: str) -> List[House]:
    """Returns the auctioned houses and guildhalls in a TibiaData houses response."""
    data = payload.get("houses") or {}
    result = []
    for key, guildhall in (("house_list", False), ("guildhall_list", True)):
        for h in data.get(key) or []:
            auction = h.get("auction") or {}
            if not h.get("auctioned") or auction.get("finished"):
                continue
            result.append(House(
                id=h["house_id"],
                name=h["name"],
                town=town,
                world=world,
                size=h.get("size", 0),
                rent=h.get("rent", 0),
                bid=auction.get("current_bid", 0),
                time_left=auction.get("time_left", ""),
                guildhall=guildhall,
            ))
    return result


def _get(client: httpx.Client, url: str, attempts: int = 3) -> httpx.Response:
    for attempt in range(1, attempts + 1):
        try:
            resp = client.get(url)
            check_response(resp, "TibiaData")
            if resp.status_code < 500:
                return resp
            log.warning("TibiaData HTTP %s", resp.status_code)
        except httpx.HTTPError as e:
            log.warning("TibiaData request failed: %s", type(e).__name__)
        if attempt < attempts:
            time.sleep(2 ** attempt)
    raise RuntimeError("TibiaData unavailable")


def fetch_auctioned_houses(
    world: str,
    towns: Iterable[str],
    user_agent: str,
    max_bid: Optional[int] = None,
    min_size: Optional[int] = None,
) -> List[House]:
    houses: List[House] = []
    with httpx.Client(headers={"User-Agent": user_agent}, timeout=30) as client:
        for town in towns:
            resp = _get(client, API.format(world=quote(world), town=quote(town)))
            payload = resp.json()
            status = (payload.get("information") or {}).get("status") or {}
            if status.get("error") == TOWN_NOT_FOUND:
                log.warning("Unknown town in config, skipping")
                continue
            if resp.status_code != 200:
                raise RuntimeError(f"TibiaData error {status.get('error')}")
            houses.extend(parse_houses(payload, world, town))
    return [
        h for h in houses
        if (max_bid is None or h.bid <= max_bid) and (min_size is None or h.size >= min_size)
    ]
