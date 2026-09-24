"""Entry point: python -m tracker [--dry-run] [--only houses|bazaar] [--contact-only]"""
from __future__ import annotations

import argparse
import html
import logging
import os
from pathlib import Path
from typing import Optional

from . import guard, notify, state as st
from .config import load_config
from .bazaar import fetch_high_skill_auctions
from .houses import fetch_auctioned_houses

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("tracker")

ALERT_AFTER_FAILURES = 2
LOCAL_KEY_FILE = ROOT / ".secrets" / "state.key"


def state_key() -> Optional[str]:
    """STATE_KEY env var (GitHub secret) or the git-ignored local key file."""
    key = os.environ.get("STATE_KEY", "").strip()
    if not key and LOCAL_KEY_FILE.exists():
        key = LOCAL_KEY_FILE.read_text().strip()
    return key or None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print notifications and don't save state")
    parser.add_argument("--only", choices=["houses", "bazaar"])
    parser.add_argument("--contact-only", action="store_true", help="only check GitHub issues for contact")
    parser.add_argument("--config", type=Path, default=ROOT / "config.yaml")
    parser.add_argument("--state-dir", type=Path, default=ROOT / "state")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = load_config(args.config)
    ua = cfg.get("user_agent", "tibia-tracker/0.1")
    max_msgs = cfg.get("pushover", {}).get("max_messages_per_category", 6)
    hcfg, bcfg = cfg["houses"], cfg["bazaar"]
    notifier = notify.Notifier(args.dry_run)
    key = state_key()
    state_path = st.path_for(args.state_dir, key)
    halt_path = args.state_dir / "halt.json"
    state = st.load(state_path, key)
    halt = guard.load(halt_path)
    now = st.utcnow()

    messages = []
    errors = []
    baseline = {}  # source -> items, for sources succeeding for the first time

    # Contact comes first: if someone has reached out, nothing else runs.
    for issue in guard.check_contact(halt, state["replied_issues"], now, args.dry_run):
        messages.append(notify.contact_message(issue))

    stopped = guard.halted_sources(halt)
    if stopped:
        log.warning("Halted sources, not fetching: %s (see state/halt.json)", ", ".join(sorted(stopped)))

    def blocked(source: str, e: guard.Blocked) -> None:
        log.error("%s blocked: %s", source, e)
        if guard.stop(halt, source, str(e), now):
            messages.append(notify.halt_message(source, str(e)))
        errors.append((source, e))

    run = not args.contact_only
    if run and hcfg.get("enabled", True) and args.only in (None, "houses") and "houses" not in stopped:
        try:
            houses = fetch_auctioned_houses(hcfg["world"], hcfg["towns"], ua, hcfg.get("max_bid"), hcfg.get("min_size"))
            log.info("%s auctioned houses", len(houses))
            changes = st.update_houses(state, houses, now)
            if st.is_baselined(state, "houses"):
                raised = changes.raised if hcfg.get("notify_bid_raises", True) else []
                messages += notify.house_messages(hcfg["world"], changes.new, raised, max_msgs)
            else:
                baseline["houses"] = houses
                st.mark_baselined(state, "houses")
            st.record_result(state, "houses", ok=True)
        except guard.Blocked as e:
            blocked("houses", e)
        except Exception as e:
            log.exception("House check failed")
            errors.append(("houses", e))

    if run and bcfg.get("enabled", True) and args.only in (None, "bazaar") and "bazaar" not in stopped:
        try:
            result = fetch_high_skill_auctions(bcfg, ua)
            log.info("%s high-skill auctions (%s requests to tibia.com)", len(result.auctions), result.requests)
            new = st.update_auctions(state, result.auctions, now)
            if st.is_baselined(state, "bazaar"):
                messages += notify.auction_messages(new, max_msgs, partial=not result.complete)
            else:
                baseline["bazaar"] = result.auctions
                st.mark_baselined(state, "bazaar")
            st.record_result(state, "bazaar", ok=True)
        except guard.Blocked as e:
            blocked("bazaar", e)
        except Exception as e:
            log.exception("Bazaar check failed")
            errors.append(("bazaar", e))

    if baseline:
        messages.append(notify.baseline_message(baseline.get("houses"), baseline.get("bazaar"), hcfg["world"]))

    for source, e in errors:
        if isinstance(e, guard.Blocked):
            continue  # already announced as a halt
        if st.record_result(state, source, ok=False) == ALERT_AFTER_FAILURES:
            messages.append(notify.Message(
                title=f"⚠️ Tibia Tracker: {source} check failing",
                body=html.escape(f"Failed {ALERT_AFTER_FAILURES} runs in a row. Last error: {e}")[:1000],
            ))

    for msg in messages:
        notifier.send(msg)
    if not messages:
        log.info("Nothing new to notify")

    if args.dry_run:
        log.info("Dry run: state not saved")
    else:
        guard.save(halt_path, halt)
        st.save(state_path, state, key)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
