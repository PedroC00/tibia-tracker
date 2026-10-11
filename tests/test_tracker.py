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


def test_house_diff_new_and_ending():
    state = st.load(Path("/nonexistent"))
    st.update_houses(state, [house(1), house(2, time_left="1 day")], NOW, 12)
    current = [house(1, 1500), house(2, time_left="11 hours"), house(3, time_left="3 hours")]
    changes = st.update_houses(state, current, NOW, 12)
    assert [h.id for h in changes.new] == [3]
    assert [h.id for h in changes.ending] == [2]
    # Each ending auction is announced once, a new one already in its last hours never twice
    again = st.update_houses(state, current, NOW, 12)
    assert again.new == [] and again.ending == []
    # Finished auctions disappear from the state
    st.update_houses(state, [house(3)], NOW, 12)
    assert list(state["houses"]) == ["3"]


def test_hours_left():
    assert house(time_left="3 days").hours_left == 72
    assert house(time_left="16 hours").hours_left == 16
    assert house(time_left="1 hour").hours_left == 1
    assert house(bid=0, time_left="").hours_left is None


def test_daily_due_once_per_day_and_catches_up():
    state = st.load(Path("/nonexistent"))
    assert st.daily_due(state, "digest", NOW, 13)  # never sent: due right away
    st.mark_daily(state, "digest", NOW)  # 12:00, before today's 13:00 slot
    assert not st.daily_due(state, "digest", NOW + timedelta(minutes=30), 13)
    late = NOW + timedelta(hours=3)  # the 13:00 run was skipped
    assert st.daily_due(state, "digest", late, 13)
    st.mark_daily(state, "digest", late)
    assert not st.daily_due(state, "digest", late + timedelta(hours=20), 13)
    assert st.daily_due(state, "digest", late + timedelta(hours=22), 13)


def test_digest_lists_every_house_soonest_first():
    houses = [house(1, bid=0, time_left=""), house(2, time_left="2 days"), house(3, time_left="5 hours")]
    [msg] = notify.digest_messages("Antica", houses, max_messages=6)
    assert msg.title == "🏠 Antica: 3 houses for auction"
    assert [line.split(" (")[0] for line in msg.body.split("\n")] == ["House 3", "House 2", "House 1"]
    assert "no bids yet" in msg.body and "href" not in msg.body
    [empty] = notify.digest_messages("Antica", [], max_messages=6)
    assert "0 houses" in empty.title and empty.body


def test_house_alerts():
    assert notify.new_house_messages("Antica", [], 6) == notify.ending_messages("Antica", [], 6) == []
    [new] = notify.new_house_messages("Antica", [house(1)], 6)
    [ending] = notify.ending_messages("Antica", [house(2, time_left="5 hours")], 6)
    assert "new" in new.title and "houseid=1" in new.body
    assert "ending" in ending.title and "5 hours left" in ending.body


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


def test_baseline_message():
    msg = notify.baseline_message([auction(1), auction(2, vocation="Elite Knight")])
    assert "2 high-skill" in msg.body
    assert len(msg.body) <= notify.MAX_MESSAGE


def test_test_message_fits():
    msg = notify.test_message()
    assert msg.title and len(msg.body) <= notify.MAX_MESSAGE and msg.priority == 0
