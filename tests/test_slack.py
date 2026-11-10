import pytest

from app.slack.format import escape, render
from app.slack.sender import Definite, RateLimited, SlackSender, Uncertain
from tests.test_translator import seed


def test_escape_blocks_mentions_and_links():
    s = escape("<!channel> <@U123> a & b <https://x|y>")
    assert "<" not in s and ">" not in s
    assert "&lt;!channel&gt;" in s and "&amp;" in s


class FakePoster:
    def __init__(self, script=None):
        self.script = list(script or [])
        self.posts = []
        self.updates = []

    def _next(self):
        if self.script:
            r = self.script.pop(0)
            if isinstance(r, Exception):
                raise r
        return None

    def post(self, token, channel, text):
        self._next()
        self.posts.append((token, channel, text))
        return f"{len(self.posts)}.000"

    def update(self, token, channel, ts, text):
        self._next()
        self.updates.append((channel, ts, text))


def setup_two_clients(db):
    seed(db, "dummy")  # creates client 1 / conv 1
    db.execute("DELETE FROM translations")
    db.execute("DELETE FROM messages")
    db.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (2,'b','B','CB','TOKB','x')")
    db.execute("INSERT INTO accounts(id,client_id,key,label,collect_method) VALUES (2,2,'b1','B1','fake')")
    db.execute("INSERT INTO conversations(id,client_id,account_id,display_name,created_at,updated_at) VALUES (2,2,2,'Lee','x','x')")


def add_outbox(db, body, client=1, conv=None, tr_status="done", ko="번역", lang="en"):
    conv = conv or client
    seq = db.execute("SELECT coalesce(max(conv_seq),0)+1 FROM messages").fetchone()[0]
    mid = db.execute(
        """INSERT INTO messages(client_id,account_id,conversation_id,conv_seq,direction,kind,body,shown_time,time_precision,
           observed_at,collect_mode,confidence,content_key,fingerprint,seq_in_batch,created_at)
           VALUES (?,?,?,?,'inbound','text',?,'10:00','minute','x','live','high','k',?,0,'x')""",
        (client, client, conv, seq, body, f"f{seq}"),
    ).lastrowid
    db.execute("INSERT INTO translations(message_id,status,lang,ko_text,updated_at) VALUES (?,?,?,?, 'x')", (mid, tr_status, lang, ko))
    db.execute(
        """INSERT INTO slack_outbox(message_id,client_id,channel_id,token_ref,status,created_at)
           SELECT ?, id, slack_channel_id, slack_token_ref, 'pending', 'x' FROM clients WHERE id=?""",
        (mid, client),
    )
    return mid


def ob(db, mid):
    return db.execute("SELECT * FROM slack_outbox WHERE message_id=?", (mid,)).fetchone()


def sender(db, poster, **kw):
    return SlackSender(db, poster, tokens={"TOK": "xoxb-a", "TOKB": "xoxb-b"}, min_interval_sec=0, **kw)


async def test_routes_to_client_channel_and_records_ts(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello A", client=1)
    b = add_outbox(db, "Hello B", client=2)
    p = FakePoster()
    await sender(db, p).tick()
    chans = {(tok, ch) for tok, ch, _ in p.posts}
    assert chans == {("xoxb-a", "CA"), ("xoxb-b", "CB")}
    assert "Hello A" in [t for _, ch, t in p.posts if ch == "CA"][0]
    assert "Hello B" not in [t for _, ch, t in p.posts if ch == "CA"][0]
    assert ob(db, a)["status"] == "sent" and ob(db, a)["slack_ts"]
    assert ob(db, b)["translation_included"] == 1


async def test_429_retries_without_duplicate(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello")
    p = FakePoster([RateLimited(30)])
    s = sender(db, p)
    await s.tick()
    r = ob(db, a)
    assert r["status"] == "retry" and r["next_attempt_at"] and p.posts == []
    db.execute("UPDATE slack_outbox SET next_attempt_at=NULL")
    s._blocked.clear()
    await s.tick()
    await s.tick()
    assert ob(db, a)["status"] == "sent" and len(p.posts) == 1


async def test_timeout_goes_unconfirmed_and_is_not_resent(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello")
    p = FakePoster([Uncertain("timeout")])
    s = sender(db, p)
    await s.tick()
    await s.tick()
    assert ob(db, a)["status"] == "unconfirmed" and p.posts == []
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='slack_unconfirmed'").fetchone()[0] == 1


async def test_definite_errors_fail_after_max(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello")
    p = FakePoster([Definite("channel_not_found")] * 3)
    s = sender(db, p, max_attempts=3)
    for _ in range(3):
        db.execute("UPDATE slack_outbox SET next_attempt_at=NULL")
        await s.tick()
    assert ob(db, a)["status"] == "failed" and ob(db, a)["attempts"] == 3


async def test_crash_mid_send_becomes_unconfirmed(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello")
    db.execute("UPDATE slack_outbox SET status='sending', locked_by='old'")
    p = FakePoster()
    s = sender(db, p)
    s.recover()
    await s.tick()
    assert ob(db, a)["status"] == "unconfirmed" and p.posts == []


async def test_pending_translation_posts_then_updates(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello", tr_status="pending", ko=None, lang=None)
    p = FakePoster()
    s = sender(db, p)
    await s.tick()
    assert "번역 중" in p.posts[0][2]
    assert ob(db, a)["translation_included"] == 0
    # translation lands -> worker marks update pending
    db.execute("UPDATE translations SET status='done', ko_text='안녕하세요', lang='en' WHERE message_id=?", (a,))
    from app.slack.outbox import on_translation_final

    on_translation_final(db, a, "done")
    await s.tick()
    assert len(p.updates) == 1 and "안녕하세요" in p.updates[0][2] and p.updates[0][1] == "1.000"
    r = ob(db, a)
    assert r["update_status"] == "done" and r["translation_included"] == 1


async def test_missing_token_is_definite(db):
    setup_two_clients(db)
    a = add_outbox(db, "Hello")
    s = SlackSender(db, FakePoster(), tokens={}, min_interval_sec=0, max_attempts=1)
    await s.tick()
    assert ob(db, a)["status"] == "failed"


def test_render_korean_original_not_duplicated():
    msg = {"id": 7, "kind": "text", "body": "예약할게요", "shown_time": "10:00", "shown_date_hint": "2026-11-09",
           "collect_mode": "live", "attachment_label": None}
    text, included = render(msg, "Kim", "A", {"status": "not_needed", "lang": "ko", "ko_text": None})
    assert text.count("예약할게요") == 1 and included
    assert "msg #7" in text


def test_render_attachment_placeholder_and_catchup():
    msg = {"id": 8, "kind": "attachment", "body": None, "shown_time": "10:00", "shown_date_hint": None,
           "collect_mode": "catchup", "attachment_label": "사진"}
    text, _ = render(msg, "Kim", "A", {"status": "not_needed", "lang": None, "ko_text": None})
    assert "[사진 첨부]" in text and "지연 수집" in text


def test_render_truncates_long_text_explicitly():
    msg = {"id": 9, "kind": "text", "body": "a" * 10000, "shown_time": None, "shown_date_hint": None,
           "collect_mode": "live", "attachment_label": None}
    text, _ = render(msg, "Kim", "A", {"status": "done", "lang": "en", "ko_text": "가" * 10000})
    assert len(text) < 4000 and "잘림" in text
