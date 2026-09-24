import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tracker import notify, state as st
from tracker.bazaar import AuctionHit, parse_page, to_hit
from tracker.houses import House, parse_houses

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)


def house(id=1, bid=1000, **kw):
    base = dict(id=id, name=f"House {id}", town="Thais", world="Antica", size=40, rent=50000,
                bid=bid, time_left="5 days", guildhall=False)
    base.update(kw)
    return House(**base)


def auction(id=1, end=NOW + timedelta(days=1), **kw):
    base = dict(id=id, name=f"Char {id}", level=500, vocation="Royal Paladin", world="Antica",
                bid=5000, bid_type="minimum", end=end, matched=["Dist ≥115"])
    base.update(kw)
    return AuctionHit(**base)


def test_parse_houses_fixture_only_returns_open_auctions():
    payload = json.loads((FIXTURES / "houses.json").read_text())
    houses = parse_houses(payload, "Antica", "Edron")
    all_entries = payload["houses"]["house_list"] + (payload["houses"]["guildhall_list"] or [])
    expected = [h for h in all_entries if h["auctioned"] and not h["auction"]["finished"]]
    assert houses and len(houses) == len(expected)
    assert all(h.town == "Edron" and h.world == "Antica" and h.bid > 0 for h in houses)


def test_parse_bazaar_fixture():
    bazaar = parse_page((FIXTURES / "bazaar_page.html").read_text())
    assert bazaar.entries
    hit = to_hit(bazaar.entries[0], "Dist ≥115")
    assert hit.id > 0 and hit.level > 0 and "Paladin" in hit.vocation
    assert "auctionid=" in hit.url


def test_house_diff_new_and_raised():
    state = st.load(Path("/nonexistent"))
    st.update_houses(state, [house(1, 1000), house(2, 500)], NOW)
    changes = st.update_houses(state, [house(1, 1500), house(2, 500), house(3, 10)], NOW)
    assert [h.id for h in changes.new] == [3]
    assert [(h.id, old) for h, old in changes.raised] == [(1, 1000)]
    # Finished auctions disappear from the state
    st.update_houses(state, [house(3, 10)], NOW)
    assert list(state["houses"]) == ["3"]


def test_auction_diff_and_prune():
    state = st.load(Path("/nonexistent"))
    assert [a.id for a in st.update_auctions(state, [auction(1), auction(2)], NOW)] == [1, 2]
    assert st.update_auctions(state, [auction(1), auction(2)], NOW) == []
    later = NOW + timedelta(days=2)
    new = st.update_auctions(state, [auction(3, end=later + timedelta(days=1))], later)
    assert [a.id for a in new] == [3]
    assert list(state["auctions"]) == ["3"]


def test_failure_streak_and_baseline():
    state = st.load(Path("/nonexistent"))
    assert st.record_result(state, "bazaar", ok=False) == 1
    assert st.record_result(state, "bazaar", ok=False) == 2
    assert st.record_result(state, "bazaar", ok=True) == 0
    assert not st.is_baselined(state, "houses")
    st.mark_baselined(state, "houses")
    assert st.is_baselined(state, "houses")


def test_messages_fit_pushover_limit_and_overflow():
    msgs = notify.auction_messages([auction(i) for i in range(100)], max_messages=3)
    assert len(msgs) == 3
    assert all(len(m.body) <= notify.MAX_MESSAGE for m in msgs)
    assert "more" in msgs[-1].body
    assert msgs[0].title.endswith("(1/3)")


def test_html_is_escaped():
    line = notify.house_line(house(name="<b>Evil & Co</b>"))
    assert "&lt;b&gt;Evil &amp; Co&lt;/b&gt;" in line


def test_baseline_message_partial_sources():
    msg = notify.baseline_message(None, [auction(1), auction(2, vocation="Elite Knight")], "Antica")
    assert "2 high-skill" in msg.body and "house" not in msg.body
    assert len(msg.body) <= notify.MAX_MESSAGE
