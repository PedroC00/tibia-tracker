"""High-skill Char Bazaar auctions, read politely from tibia.com and parsed with tibia.py.

There is no open API for current auctions, so each run makes a small number of
filtered requests (one query per vocation/skill, a few pages each) with a delay
between them and a hard request budget.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

import httpx
from tibiapy import urls
from tibiapy.enums import AuctionSkillFilter, AuctionVocationFilter, BazaarType, PvpTypeFilter
from tibiapy.models import AuctionFilters
from tibiapy.parsers import CharacterBazaarParser

from .guard import check_response

log = logging.getLogger(__name__)

SKILL_LABELS = {
    "SWORD_FIGHTING": "Sword",
    "AXE_FIGHTING": "Axe",
    "CLUB_FIGHTING": "Club",
    "DISTANCE_FIGHTING": "Dist",
    "MAGIC_LEVEL": "ML",
    "FIST_FIGHTING": "Fist",
    "SHIELDING": "Shield",
}


class _BudgetExhausted(Exception):
    pass


@dataclass
class AuctionHit:
    id: int
    name: str
    level: int
    vocation: str
    world: str
    bid: int
    bid_type: str  # "minimum" or "current"
    end: datetime
    matched: List[str] = field(default_factory=list)  # e.g. ["Dist ≥115"]

    @property
    def url(self) -> str:
        return urls.get_auction_url(self.id)


@dataclass
class BazaarResult:
    auctions: List[AuctionHit]
    requests: int
    complete: bool  # False when the request budget ran out


class _Fetcher:
    def __init__(self, user_agent: str, delay: float, budget: int):
        self.client = httpx.Client(headers={"User-Agent": user_agent}, timeout=30, follow_redirects=True)
        self.delay = delay
        self.budget = budget
        self.requests = 0

    def get(self, url: str) -> str:
        """Blocks, challenges and rate limits raise guard.Blocked at once; 5xx gets one retry."""
        if self.requests:
            time.sleep(self.delay)
        for attempt in (1, 2):
            self.requests += 1
            resp = self.client.get(url)
            check_response(resp, "tibia.com")
            if resp.status_code == 200:
                return resp.text
            if attempt == 2 or self.requests >= self.budget:
                break
            log.warning("tibia.com HTTP %s, retrying once in 60 s", resp.status_code)
            time.sleep(60)
        raise RuntimeError(f"tibia.com answered HTTP {resp.status_code}")  # no URL: it holds the filters

    def close(self):
        self.client.close()


def parse_page(html: str):
    try:
        return CharacterBazaarParser.from_content(html)
    except Exception as e:  # tibia.py raises on unexpected pages, e.g. after a layout change
        raise RuntimeError(f"Could not parse bazaar page: {e}") from e


def to_hit(auction, label: str) -> AuctionHit:
    return AuctionHit(
        id=auction.auction_id,
        name=auction.name,
        level=auction.level,
        vocation=auction.vocation.value,
        world=auction.world,
        bid=auction.bid,
        bid_type=auction.bid_type.value,
        end=auction.auction_end,
        matched=[label],
    )


def fetch_high_skill_auctions(cfg: dict, user_agent: str) -> BazaarResult:
    fetcher = _Fetcher(user_agent, cfg.get("request_delay_seconds", 3), cfg.get("max_requests_per_run", 60))
    hits: Dict[int, AuctionHit] = {}
    complete = True
    query = 0
    try:
        for pvp in cfg["pvp_types"]:
            for vocation, skills in cfg["high_skill"].items():
                for skill, minimum in skills.items():
                    query += 1
                    label = f"{SKILL_LABELS.get(skill, skill)} ≥{minimum}"
                    filters = AuctionFilters(
                        pvp_type=PvpTypeFilter[pvp],
                        vocation=AuctionVocationFilter[vocation],
                        skill=AuctionSkillFilter[skill],
                        min_skill_level=minimum,
                        min_level=cfg.get("min_level"),
                    )
                    page, total = 1, 1
                    while page <= total:
                        if fetcher.requests >= fetcher.budget:
                            log.warning("Request budget (%s) reached, results are partial", fetcher.budget)
                            raise _BudgetExhausted
                        bazaar = parse_page(fetcher.get(urls.get_bazaar_url(BazaarType.CURRENT, page, filters)))
                        total = bazaar.total_pages or 1
                        for a in bazaar.entries:
                            if a.auction_id in hits:
                                if label not in hits[a.auction_id].matched:
                                    hits[a.auction_id].matched.append(label)
                            else:
                                hits[a.auction_id] = to_hit(a, label)
                        # Deliberately vague: Actions logs are public.
                        log.info("Bazaar query %s, page %s/%s", query, page, total)
                        page += 1
    except _BudgetExhausted:
        complete = False
    finally:
        fetcher.close()

    max_bid: Optional[int] = cfg.get("max_bid_tc")
    auctions = [h for h in hits.values() if max_bid is None or h.bid <= max_bid]
    return BazaarResult(auctions=auctions, requests=fetcher.requests, complete=complete)
