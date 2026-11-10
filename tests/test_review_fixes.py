"""Regression tests for the final-review findings (C1, C2, I1-I6)."""
import asyncio

import pytest

from app.api.bus import Bus
from app.collector.contract import FakeReader, MessageWindow, ObservedConversation, ObservedMessage, ReaderStatus
from app.collector.loop import AccountCollector, run_collector
from app.db.repo import connect
from app.translator.gpt import ServiceError, TranslationResult
from app.translator.worker import TranslatorWorker
from tests.test_collector import M, make, rows, setup  # noqa: F401  (fixture)
from tests.test_translator import FakeGPT, seed


def high_new(db, after_id):
    return db.execute(
        "SELECT body FROM messages WHERE id>? AND confidence='high' AND direction='inbound' AND collect_mode!='baseline'",
        (after_id,),
    ).fetchall()


def max_id(db):
    return db.execute("SELECT coalesce(max(id),0) FROM messages").fetchone()[0]


# C1 ---------------------------------------------------------------------------------------
def test_deleted_newest_message_does_not_reinsert_history(setup):
    db, r = setup
    r.add("Kim", *[M(f"m{i}", t=f"09:{i:02d}") for i in range(10)])
    make(db, r).run_pass()
    r.add("Kim", M("new 1", t="10:00"))
    make(db, r).run_pass()
    before = max_id(db)
    r.conversations["Kim"][-1] = M("이 메시지는 삭제되었습니다", t="10:00")
    make(db, r).run_pass()
    make(db, r).run_pass()
    assert len(rows(db)) <= 12
    assert high_new(db, before) == []


def test_true_gap_is_capped_and_review(setup):
    db, r = setup
    r.add("Kim", M("a"))
    make(db, r, recent_window=5).run_pass()
    r.conversations["Kim"] = [M(f"x{i}", t=f"11:{i:02d}") for i in range(80)]
    before = max_id(db)
    make(db, r, recent_window=5, baseline_max=50).run_pass()
    got = db.execute("SELECT confidence FROM messages WHERE id>?", (before,)).fetchall()
    assert 0 < len(got) <= 5 and {g[0] for g in got} == {"review"}


class TwoJohns(FakeReader):
    def list_conversations(self):
        return [ObservedConversation("John", list_cursor="1"), ObservedConversation("John", list_cursor="2")]

    def read_messages(self, conv, limit):
        return MessageWindow([M("from " + conv.list_cursor)], at_start=True)


def test_duplicate_display_names_without_key_are_not_collected(setup):
    db, _ = setup
    r = TwoJohns()
    for _ in range(3):
        make(db, r).run_pass()
    assert rows(db) == []
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='duplicate_display_name'").fetchone()[0] == 1


# C2 ---------------------------------------------------------------------------------------
def test_one_failing_conversation_does_not_block_new_customer_alerts(setup):
    db, r = setup
    r.add("Kim", M("hi"))
    r.add("Broken", M("x"))
    orig = r.read_messages

    def flaky(conv, limit):
        if conv.display_name == "Broken":
            raise RuntimeError("unparseable bubble")
        return orig(conv, limit)

    r.read_messages = flaky
    c = make(db, r, full_sweep_interval_sec=0)
    c.run_pass()
    c.run_pass()
    c.run_pass()
    assert db.execute("SELECT initial_sync_done FROM accounts").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='read_failed'").fetchone()[0] == 1
    r.add("NewCustomer", M("first question"))
    c.run_pass()
    assert ("first question", "live") in {(x["body"], x["collect_mode"]) for x in rows(db)}


# I1 ---------------------------------------------------------------------------------------
def test_edit_in_middle_keeps_trailing_alertable(setup):
    db, r = setup
    r.add("Kim", *[M(c, t=f"09:0{i}") for i, c in enumerate("abcde")])
    make(db, r).run_pass()
    before = max_id(db)
    msgs = r.conversations["Kim"]
    msgs[1] = M("b (edited)", t="09:01")
    r.add("Kim", M("new", t="10:00"))
    make(db, r, recent_window=10).run_pass()
    assert [x[0] for x in high_new(db, before)] == ["new"]
    review = db.execute("SELECT body FROM messages WHERE id>? AND confidence='review'", (before,)).fetchall()
    assert [x[0] for x in review] == ["b (edited)"]


def test_late_arriving_message_is_stored_not_lost(setup):
    db, r = setup
    r.add("Kim", M("a", t="09:00"), M("b", t="09:02"))
    make(db, r).run_pass()
    r.conversations["Kim"] = [M("a", t="09:00"), M("late", t="09:01"), M("b", t="09:02"), M("c", t="09:03")]
    make(db, r).run_pass()
    got = {(x["body"], x["confidence"]) for x in rows(db)}
    assert ("late", "review") in got and ("c", "high") in got


# I2 ---------------------------------------------------------------------------------------
def test_rename_without_key_does_not_realert(setup):
    db, r = setup
    r.add("Other", M("x"))
    r.add("+82 10-1234", M("hello", t="09:00"))
    make(db, r).run_pass()
    r.add("+82 10-1234", M("price please", t="09:05"))
    make(db, r).run_pass()
    before = max_id(db)
    r.conversations["Kim (saved)"] = r.conversations.pop("+82 10-1234")
    r.meta.pop("+82 10-1234")
    r.meta["Kim (saved)"] = ObservedConversation("Kim (saved)")
    make(db, r).run_pass()
    assert max_id(db) == before
    names = {x[0] for x in db.execute("SELECT display_name FROM conversations")}
    assert names == {"Other", "Kim (saved)"}
    assert tuple(db.execute("SELECT old_name, new_name FROM conversation_name_history").fetchone()) == ("+82 10-1234", "Kim (saved)")


# I3 ---------------------------------------------------------------------------------------
async def test_bus_overflow_closes_subscriber(db_path):
    c = connect(db_path)
    seed(c, "hello")
    bus = Bus(lambda: connect(db_path), queue_size=3)
    q = bus.subscribe()
    bus.publish_messages([1, 1, 1, 1, 1])
    assert bus.is_closed(q)


async def test_bus_large_burst_forces_resync(db_path):
    c = connect(db_path)
    seed(c, "hello")
    bus = Bus(lambda: connect(db_path), burst_limit=2)
    q = bus.subscribe()
    bus.publish_messages([1, 1, 1])
    assert bus.is_closed(q) and q.qsize() == 0


# I4 ---------------------------------------------------------------------------------------
async def test_live_message_translated_before_baseline_backlog(db):
    for i in range(10):
        seed(db, f"old foreign {i}", mode="baseline")
    live = seed(db, "Is it open today?")
    gpt = FakeGPT([TranslationResult("en", "x")] * 20)
    await TranslatorWorker(db, gpt, model="m", batch=3).tick()
    assert db.execute("SELECT status FROM translations WHERE message_id=?", (live,)).fetchone()[0] == "done"


async def test_service_error_stops_batch(db):
    for i in range(3):
        seed(db, f"hello {i}")
    gpt = FakeGPT([ServiceError("timeout")] * 3)
    await TranslatorWorker(db, gpt, model="m").tick()
    assert len(gpt.calls) == 1


# I5 ---------------------------------------------------------------------------------------
def test_duplicate_external_id_in_window_does_not_wedge(setup):
    db, r = setup
    r.add("Kim", M("x", external_id="1"), M("x", external_id="1"), M("y", external_id="2"))
    c = make(db, r)
    c.run_pass()
    assert [x["external_id"] for x in rows(db)] == ["1", "2"]
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='read_failed'").fetchone()[0] == 0


# I6 ---------------------------------------------------------------------------------------
async def test_stalled_collector_trips_watchdog(setup):
    db, r = setup
    import threading

    release = threading.Event()

    class Hung(FakeReader):
        def status(self):
            release.wait(5)
            return ReaderStatus("ok")

    c = make(db, Hung())
    tripped = []
    task = asyncio.create_task(run_collector(c, 0.01, asyncio.Event(), stall_timeout_sec=0.2, fatal=tripped.append,
                                            check_interval_sec=0.05))
    await asyncio.sleep(0.5)
    release.set()
    task.cancel()
    assert tripped
