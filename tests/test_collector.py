from datetime import datetime, timedelta, timezone

import pytest

from app.collector.contract import FakeReader, ObservedMessage, ReaderStatus
from app.collector.loop import AccountCollector
from app.db.repo import iso


def M(body, d="inbound", t="10:00", **kw):
    return ObservedMessage(direction=d, kind=kw.pop("kind", "text"), body=body, shown_time=t, shown_date_hint="2026-11-09", **kw)


@pytest.fixture
def setup(db):
    db.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'a','A','CA','TOK','x')")
    db.execute("INSERT INTO accounts(id,client_id,key,label,collect_method) VALUES (1,1,'a1','A1','fake')")
    reader = FakeReader()
    return db, reader


def make(db, reader, **kw):
    kw.setdefault("recent_window", 5)
    kw.setdefault("baseline_max", 50)
    return AccountCollector(db, reader, account_id=1, client_id=1, **kw)


def rows(db, conv_name=None):
    q = "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id"
    args = ()
    if conv_name:
        q += " WHERE c.display_name=?"
        args = (conv_name,)
    return db.execute(q + " ORDER BY m.conversation_id, m.conv_seq", args).fetchall()


def test_initial_baseline_then_live(setup):
    db, r = setup
    r.add("Kim", M("hello"), M("안녕하세요", d="outbound"))
    c = make(db, r)
    c.run_pass()
    got = rows(db)
    assert [(x["body"], x["collect_mode"]) for x in got] == [("hello", "baseline"), ("안녕하세요", "baseline")]
    assert db.execute("SELECT initial_sync_done FROM accounts").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM translations WHERE status='pending'").fetchone()[0] == 2

    r.add("Kim", M("price?", t="10:05"))
    c.run_pass()
    assert [(x["body"], x["collect_mode"]) for x in rows(db)][-1] == ("price?", "live")


def test_two_identical_ne_kept_and_restart_no_dupes(setup):
    db, r = setup
    r.add("Kim", M("hi"))
    make(db, r).run_pass()
    r.add("Kim", M("네", t="10:01"), M("네", t="10:01"))
    make(db, r).run_pass()
    assert [x["body"] for x in rows(db)] == ["hi", "네", "네"]
    # simulated restart: fresh collector, same window re-read
    make(db, r).run_pass()
    make(db, r).run_pass()
    assert len(rows(db)) == 3


def test_new_conversation_after_initial_sync_alerts_only_trailing_inbound(setup):
    db, r = setup
    r.add("Kim", M("hi"))
    make(db, r).run_pass()
    r.add("NewCustomer", M("first question"), M("second"))
    r.add("OldResurfaced", M("old q", t="09:00"), M("old a", d="outbound", t="09:01"), M("new q", t="10:30"))
    make(db, r).run_pass()
    modes = {(x["body"], x["collect_mode"]) for x in rows(db)}
    assert ("first question", "live") in modes and ("second", "live") in modes
    assert ("old q", "baseline") in modes and ("old a", "baseline") in modes and ("new q", "live") in modes


def test_groups_and_excluded_skipped(setup):
    db, r = setup
    r.add("Team", M("x"), is_group=True)
    r.add("Mom", M("y"))
    c = make(db, r, exclude=["Mom"])
    c.run_pass()
    c.run_pass()
    assert rows(db) == []
    ev = db.execute("SELECT kind FROM ops_events WHERE kind='group_skipped'").fetchall()
    assert len(ev) == 1


def test_gap_triggers_scrollback_and_catchup(setup):
    db, r = setup
    r.add("Kim", M("a"))
    make(db, r, recent_window=2).run_pass()
    r.add("Kim", *[M(f"m{i}", t=f"11:{i:02d}") for i in range(5)])
    make(db, r, recent_window=2).run_pass()
    got = rows(db)
    assert [x["body"] for x in got] == ["a", "m0", "m1", "m2", "m3", "m4"]
    assert {x["collect_mode"] for x in got[1:]} == {"catchup"}


def test_disconnected_then_recovery_is_catchup(setup):
    db, r = setup
    r.add("Kim", M("a"))
    c = make(db, r)
    c.run_pass()
    r.state = ReaderStatus("disconnected", "phone offline")
    r.add("Kim", M("while down", t="10:10"))
    c.run_pass()
    assert len(rows(db)) == 1
    acc = db.execute("SELECT status FROM accounts").fetchone()
    assert acc["status"] == "disconnected"
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='account_status'").fetchone()[0] == 1
    r.state = ReaderStatus("ok")
    c.run_pass()
    last = rows(db)[-1]
    assert (last["body"], last["collect_mode"]) == ("while down", "catchup")


def test_stale_last_ok_marks_catchup(setup):
    db, r = setup
    r.add("Kim", M("a"))
    make(db, r).run_pass()
    old = iso(datetime.now(timezone.utc) - timedelta(minutes=30))
    db.execute("UPDATE accounts SET last_ok_at=?", (old,))
    r.add("Kim", M("b", t="10:20"))
    make(db, r).run_pass()
    assert rows(db)[-1]["collect_mode"] == "catchup"


def test_review_confidence(setup):
    db, r = setup
    r.add("Kim", M("a"))
    make(db, r).run_pass()
    r.add("Kim", M("who?", d="unknown", t="10:30"), M("quoted?", t="10:31", flags=("quote_suspect",)))
    make(db, r).run_pass()
    got = rows(db)[-2:]
    assert [x["confidence"] for x in got] == ["review", "review"]


def test_rename_with_external_key(setup):
    db, r = setup
    r.add("Kim", M("a"), key="jid-1")
    make(db, r).run_pass()
    r.meta.clear()
    r.conversations["Kim J"] = r.conversations.pop("Kim")
    r.add("Kim J", M("b", t="10:40"), key="jid-1")
    make(db, r).run_pass()
    assert db.execute("SELECT count(*) FROM conversations").fetchone()[0] == 1
    assert db.execute("SELECT display_name FROM conversations").fetchone()[0] == "Kim J"
    h = db.execute("SELECT old_name, new_name FROM conversation_name_history").fetchone()
    assert tuple(h) == ("Kim", "Kim J")


def test_reader_failure_does_not_advance_cursor(setup):
    db, r = setup
    r.add("Kim", M("a"))
    make(db, r).run_pass()
    cur_before = db.execute("SELECT last_seen_cursor FROM conversations").fetchone()[0]
    r.add("Kim", M("b", t="10:50"))

    class Boom(Exception):
        pass

    orig = r.read_messages

    def broken(conv, limit):
        raise Boom()

    r.read_messages = broken
    c = make(db, r)
    c.run_pass()
    assert db.execute("SELECT last_seen_cursor FROM conversations").fetchone()[0] == cur_before
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='read_failed'").fetchone()[0] == 1
    r.read_messages = orig
    c.run_pass()
    assert rows(db)[-1]["body"] == "b"


def test_unchanged_cursor_skips_read_until_full_sweep(setup):
    db, r = setup
    r.add("Kim", M("a"))
    c = make(db, r, full_sweep_interval_sec=3600)
    c.run_pass()
    n = len(r.reads)
    c.run_pass()
    assert len(r.reads) == n
    c.full_sweep_interval_sec = 0
    c.run_pass()
    assert len(r.reads) == n + 1


def test_new_message_callback(setup):
    db, r = setup
    seen = []
    r.add("Kim", M("a"))
    c = make(db, r, on_new=seen.extend)
    c.run_pass()
    assert len(seen) == 1
