"""Message formatting and delivery through Pushover (https://pushover.net/api)."""
from __future__ import annotations

import html
import logging
import os
from dataclasses import dataclass
from typing import List, Optional

import httpx

from .bazaar import AuctionHit
from .houses import House

log = logging.getLogger(__name__)

PUSHOVER_URL = "https://api.pushover.net/1/messages.json"
MAX_MESSAGE = 1024

VOCATION_SHORT = {
    "Elite Knight": "EK", "Knight": "K",
    "Royal Paladin": "RP", "Paladin": "P",
    "Master Sorcerer": "MS", "Sorcerer": "S",
    "Elder Druid": "ED", "Druid": "D",
    "Exalted Monk": "EM", "Monk": "M",
}


@dataclass
class Message:
    title: str
    body: str  # Pushover HTML subset
    url: Optional[str] = None
    url_title: Optional[str] = None
    priority: int = 0  # 1 = high priority, bypasses Pushover quiet hours


def gold(n: int) -> str:
    return f"{n:,}"


def _link(text: str, url: str) -> str:
    return f'<a href="{html.escape(url)}">{html.escape(text)}</a>'


def house_line(h: House, link: bool = True) -> str:
    name = _link(h.name, h.url) if link else html.escape(h.name)
    kind = "GH " if h.guildhall else ""
    status = f"bid {gold(h.bid)} · {html.escape(h.time_left)} left" if h.time_left else "no bids yet"
    return f"{name} ({kind}{html.escape(h.town)}) · {h.size} sqm · {status}"


def auction_line(a: AuctionHit) -> str:
    voc = VOCATION_SHORT.get(a.vocation, a.vocation)
    kind = "bid" if a.bid_type == "current" else "min"
    return (f"{_link(a.name, a.url)} {a.level} {voc} · {html.escape(a.world)} · "
            f"{html.escape(', '.join(a.matched))} · {kind} {gold(a.bid)} TC · "
            f"ends {a.end:%d %b %H:%M} UTC")


def _paginate(title: str, lines: List[str], max_messages: int) -> List[Message]:
    """Packs lines into messages under Pushover's 1024-char limit."""
    chunks: List[List[str]] = [[]]
    for line in lines:
        if len("\n".join(chunks[-1] + [line])) > MAX_MESSAGE - 40:  # room for an overflow note
            chunks.append([])
        chunks[-1].append(line)
    chunks = [c for c in chunks if c]
    shown = chunks[:max_messages]
    hidden = sum(len(c) for c in chunks[max_messages:])
    if hidden:
        shown[-1] = shown[-1] + [f"… and {hidden} more"]
    total = len(shown)
    return [
        Message(title=title if total == 1 else f"{title} ({i}/{total})", body="\n".join(c))
        for i, c in enumerate(shown, 1)
    ]


def _soonest_first(houses: List[House]) -> List[House]:
    """Auctions closest to their end first; houses nobody has bid on last."""
    return sorted(houses, key=lambda h: (h.hours_left is None, h.hours_left or 0, h.name))


def digest_messages(world: str, houses: List[House], max_messages: int) -> List[Message]:
    """The daily list of every open auction. No links, so more houses fit in one message."""
    title = f"🏠 {world}: {len(houses)} houses for auction"
    if not houses:
        return [Message(title=title, body="No houses for auction right now.")]
    return _paginate(title, [house_line(h, link=False) for h in _soonest_first(houses)], max_messages)


def new_house_messages(world: str, new: List[House], max_messages: int) -> List[Message]:
    if not new:
        return []
    return _paginate(f"🆕 {world}: {len(new)} new for auction",
                     [house_line(h) for h in _soonest_first(new)], max_messages)


def ending_messages(world: str, ending: List[House], max_messages: int) -> List[Message]:
    if not ending:
        return []
    return _paginate(f"⏳ {world}: {len(ending)} ending soon",
                     [house_line(h) for h in _soonest_first(ending)], max_messages)


def auction_messages(new: List[AuctionHit], max_messages: int, partial: bool = False) -> List[Message]:
    if not new:
        return []
    lines = [auction_line(a) for a in new]
    if partial:
        lines.append("(request budget reached, some auctions may be missing)")
    return _paginate(f"⚔️ {len(new)} new high-skill auctions", lines, max_messages)


def baseline_message(auctions: List[AuctionHit]) -> Message:
    """Summary of the first successful bazaar run, sent instead of one alert per auction."""
    by_voc: dict = {}
    for a in auctions:
        voc = VOCATION_SHORT.get(a.vocation, a.vocation)
        by_voc[voc] = by_voc.get(voc, 0) + 1
    lines = [
        "Bazaar tracking started.",
        f"{len(auctions)} high-skill Open PvP auctions: " + ", ".join(f"{v} {n}" for v, n in sorted(by_voc.items())),
        "From now on you'll only get new auctions.",
    ]
    return Message(title="🧭 Tibia Tracker is running", body="\n".join(lines)[:MAX_MESSAGE])


class Notifier:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.token = os.environ.get("PUSHOVER_TOKEN")
        self.user = os.environ.get("PUSHOVER_USER")
        if not dry_run and not (self.token and self.user):
            raise SystemExit("PUSHOVER_TOKEN and PUSHOVER_USER must be set (or use --dry-run)")

    def send(self, msg: Message) -> None:
        if self.dry_run:
            print(f"\n=== {msg.title}{' [HIGH]' if msg.priority else ''} ===\n{msg.body}")
            return
        data = {"token": self.token, "user": self.user, "title": msg.title, "message": msg.body,
                "html": 1, "priority": msg.priority}
        if msg.url:
            data.update(url=msg.url, url_title=msg.url_title or "Open")
        resp = httpx.post(PUSHOVER_URL, data=data, timeout=30)
        if resp.status_code != 200:
            log.error("Pushover rejected message %r: %s", msg.title, resp.text)
            resp.raise_for_status()


RESUME_HINT = "To resume: delete the entry (or the whole file) state/halt.json in the repo."


def halt_message(source: str, reason: str) -> Message:
    what = {"bazaar": "Char Bazaar checks", "houses": "house checks"}[source]
    return Message(
        title=f"🛑 Tibia Tracker: {what} stopped",
        body=html.escape(f"{reason}. No more requests will be made to that source.\n{RESUME_HINT}"),
        priority=1,
    )


def contact_message(issue: dict) -> Message:
    return Message(
        title="📬 Someone contacted you on GitHub: tracker stopped",
        body=html.escape(
            f"#{issue['number']} by {issue['user']['login']}: {issue['title']}\n"
            f"All fetching is halted and they got the automatic reply. Answer them personally.\n{RESUME_HINT}"
        ),
        url=issue["html_url"],
        url_title="Open the issue",
        priority=1,
    )


def test_message() -> Message:
    return Message(
        title="✅ Tibia Tracker test",
        body="Pushover is set up correctly. House alerts will arrive like this.",
        url="https://github.com/PedroC00/tibia-tracker/actions",
        url_title="Open the workflow runs",
    )
