"""Persistent record of what has already been notified.

With a STATE_KEY it is stored encrypted (state/seen.json.enc) so it can live in a
public repo without revealing which auctions matched; without one, as plain JSON.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

from cryptography.fernet import Fernet

from .bazaar import AuctionHit
from .houses import House

EMPTY = {"houses": {}, "auctions": {}, "failures": {}, "baselined": [], "replied_issues": [], "announced": []}


def path_for(state_dir: Path, key: Optional[str]) -> Path:
    return state_dir / ("seen.json.enc" if key else "seen.json")


def _read(path: Path, key: Optional[str]) -> Optional[str]:
    if not path.exists():
        return None
    data = path.read_bytes()
    return Fernet(key).decrypt(data).decode() if key else data.decode()


def _dump(state: dict) -> str:
    return json.dumps(state, indent=2, sort_keys=True) + "\n"


def load(path: Path, key: Optional[str] = None) -> dict:
    text = _read(path, key)
    state = json.loads(text) if text else {}
    for name, value in EMPTY.items():
        state.setdefault(name, type(value)())
    return state


def is_baselined(state: dict, source: str) -> bool:
    """False until a source has succeeded once; its first results seed the state silently."""
    return source in state["baselined"]


def mark_baselined(state: dict, source: str) -> None:
    if source not in state["baselined"]:
        state["baselined"].append(source)


def save(path: Path, state: dict, key: Optional[str] = None) -> None:
    """Writes only when the content changed (encryption output differs on every call)."""
    text = _dump(state)
    if _read(path, key) == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(Fernet(key).encrypt(text.encode()) if key else text.encode())


@dataclass
class HouseChanges:
    new: List[House]
    raised: List[Tuple[House, int]]  # (house, previous bid)


def update_houses(state: dict, houses: List[House], now: datetime) -> HouseChanges:
    """Diffs against the stored houses, then replaces them with the current auctions."""
    prev = state["houses"]
    new, raised = [], []
    current = {}
    for h in houses:
        key = str(h.id)
        old = prev.get(key)
        if old is None:
            new.append(h)
        elif h.bid > old["bid"]:
            raised.append((h, old["bid"]))
        current[key] = {
            "bid": h.bid,
            "name": h.name,
            "town": h.town,
            "first_seen": old["first_seen"] if old else now.isoformat(),
        }
    state["houses"] = current  # houses no longer listed have finished
    return HouseChanges(new=new, raised=raised)


def update_auctions(state: dict, auctions: List[AuctionHit], now: datetime) -> List[AuctionHit]:
    """Returns auctions not seen before, records them, and prunes auctions that have ended."""
    prev = state["auctions"]
    new = []
    for a in auctions:
        key = str(a.id)
        if key not in prev:
            new.append(a)
            prev[key] = {"first_seen": now.isoformat(), "name": a.name}
        prev[key].update(bid=a.bid, end=a.end.isoformat())
    for key in [k for k, v in prev.items() if datetime.fromisoformat(v["end"]) < now]:
        del prev[key]
    return sorted(new, key=lambda a: a.end)


def record_result(state: dict, source: str, ok: bool) -> int:
    """Tracks consecutive failures per source; returns the current streak."""
    streak = 0 if ok else state["failures"].get(source, 0) + 1
    state["failures"][source] = streak
    return streak


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
