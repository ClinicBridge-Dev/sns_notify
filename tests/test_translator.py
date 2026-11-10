from datetime import datetime, timedelta, timezone

import pytest

from app.db.repo import iso
from app.translator.detect import detect
from app.translator.gpt import ContentError, ServiceError, TranslationResult
from app.translator.worker import TranslatorWorker


@pytest.mark.parametrize(
    "text,expected",
    [
        ("안녕하세요 예약 문의드려요", ("ko", False)),
        ("네", ("ko", False)),
        ("123 456", ("unknown", False)),
        ("👍👍", ("unknown", False)),
        ("", ("unknown", False)),
        ("Hello, how much is it?", (None, True)),
        ("안녕하세요 I want botox", (None, True)),
        ("こんにちは", (None, True)),
        ("https://example.com 감사합니다", ("ko", False)),
    ],
)
def test_detect(text, expected):
    assert detect(text) == expected


def seed(db, body, direction="inbound", mode="live", confidence="high", kind="text", created_at=None):
    db.execute("INSERT OR IGNORE INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'a','A','CA','TOK','x')")
    db.execute("INSERT OR IGNORE INTO accounts(id,client_id,key,label,collect_method) VALUES (1,1,'a1','A1','fake')")
    db.execute("INSERT OR IGNORE INTO conversations(id,client_id,account_id,display_name,created_at,updated_at) VALUES (1,1,1,'Kim','x','x')")
    seq = db.execute("SELECT coalesce(max(conv_seq),0)+1 FROM messages").fetchone()[0]
    ts = created_at or iso(datetime.now(timezone.utc))
    cur = db.execute(
        """INSERT INTO messages(client_id,account_id,conversation_id,conv_seq,direction,kind,body,time_precision,observed_at,
           collect_mode,confidence,content_key,fingerprint,seq_in_batch,created_at)
           VALUES (1,1,1,?,?,?,?,'minute',?,?,?,'k',?,0,?)""",
        (seq, direction, kind, body, ts, mode, confidence, f"fp{seq}", ts),
    )
    db.execute("INSERT INTO translations(message_id,status,updated_at) VALUES (?, 'pending', ?)", (cur.lastrowid, ts))
    return cur.lastrowid


class FakeGPT:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    async def __call__(self, text):
        self.calls.append(text)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def tr(db, mid):
    return db.execute("SELECT * FROM translations WHERE message_id=?", (mid,)).fetchone()


def outbox(db):
    return db.execute("SELECT * FROM slack_outbox ORDER BY id").fetchall()


async def test_korean_needs_no_call_and_enqueues(db):
    mid = seed(db, "예약 가능한가요?")
    gpt = FakeGPT([])
    await TranslatorWorker(db, gpt, model="m").tick()
    assert gpt.calls == []
    assert tr(db, mid)["status"] == "not_needed" and tr(db, mid)["lang"] == "ko"
    assert [o["message_id"] for o in outbox(db)] == [mid]


async def test_foreign_translated_then_enqueued(db):
    mid = seed(db, "How much?")
    gpt = FakeGPT([TranslationResult("en", "얼마예요?")])
    await TranslatorWorker(db, gpt, model="m").tick()
    t = tr(db, mid)
    assert (t["status"], t["lang"], t["ko_text"], t["model"]) == ("done", "en", "얼마예요?", "m")
    assert len(outbox(db)) == 1


async def test_not_eligible_for_slack(db):
    a = seed(db, "hi there", direction="outbound")
    b = seed(db, "old", mode="baseline")
    c = seed(db, "??", direction="unknown", confidence="review")
    gpt = FakeGPT([TranslationResult("en", "x")] * 3)
    await TranslatorWorker(db, gpt, model="m").tick()
    assert outbox(db) == []
    assert all(tr(db, m)["status"] in ("done", "not_needed") for m in (a, b, c))


async def test_attachment_without_caption_still_alerts(db):
    mid = seed(db, None, kind="attachment")
    await TranslatorWorker(db, FakeGPT([]), model="m").tick()
    assert tr(db, mid)["status"] == "not_needed"
    assert len(outbox(db)) == 1


async def test_service_error_keeps_retrying_beyond_max(db):
    mid = seed(db, "Hello")
    gpt = FakeGPT([ServiceError("network")] * 8 + [TranslationResult("en", "안녕")])
    w = TranslatorWorker(db, gpt, model="m", max_attempts=5)
    for _ in range(9):
        db.execute("UPDATE translations SET next_attempt_at=NULL")
        await w.tick()
    assert tr(db, mid)["status"] == "done"
    kinds = [r[0] for r in db.execute("SELECT kind FROM ops_events")]
    assert kinds.count("translation_failing") == 1


async def test_content_error_fails_after_max_and_still_alerts(db):
    mid = seed(db, "Hello")
    gpt = FakeGPT([ContentError("bad json")] * 5)
    w = TranslatorWorker(db, gpt, model="m", max_attempts=5)
    for _ in range(5):
        db.execute("UPDATE translations SET next_attempt_at=NULL")
        await w.tick()
    t = tr(db, mid)
    assert t["status"] == "failed" and t["attempts"] == 5
    assert len(outbox(db)) == 1


async def test_retry_respects_backoff(db):
    mid = seed(db, "Hello")
    gpt = FakeGPT([ContentError("x"), TranslationResult("en", "y")])
    w = TranslatorWorker(db, gpt, model="m")
    await w.tick()
    await w.tick()
    assert tr(db, mid)["status"] == "retry" and len(gpt.calls) == 1


async def test_stale_pending_enqueued_without_translation(db):
    old = iso(datetime.now(timezone.utc) - timedelta(seconds=120))
    mid = seed(db, "Hello", created_at=old)
    db.execute("UPDATE translations SET status='retry', next_attempt_at=? ", (iso(datetime.now(timezone.utc) + timedelta(hours=1)),))
    await TranslatorWorker(db, FakeGPT([]), model="m", wait_before_slack_sec=60).tick()
    assert [o["message_id"] for o in outbox(db)] == [mid]


async def test_translation_after_sent_marks_update(db):
    mid = seed(db, "Hello")
    db.execute(
        """INSERT INTO slack_outbox(message_id,client_id,channel_id,token_ref,status,slack_ts,translation_included,created_at)
           VALUES (?,1,'CA','TOK','sent','1.1',0,'x')""",
        (mid,),
    )
    await TranslatorWorker(db, FakeGPT([TranslationResult("en", "안녕")]), model="m").tick()
    assert outbox(db)[0]["update_status"] == "pending"


async def test_gpt_says_korean(db):
    mid = seed(db, "ㅋㅋ ok 네")
    await TranslatorWorker(db, FakeGPT([TranslationResult("ko", None)]), model="m").tick()
    assert tr(db, mid)["status"] == "not_needed"
