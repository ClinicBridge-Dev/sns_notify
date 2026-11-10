import pytest
from fastapi.testclient import TestClient

from app.api.auth import SessionAuth
from app.api.bus import Bus
from app.api.server import create_app
from app.db.repo import connect
from app.notices.instagram import NoticeSender, ingest
from app.ops.status import summary
from app.slack.sender import Uncertain
from tests.test_slack import FakePoster


def payload(*rows, total=None, folder="primary", account="daclinic_en"):
    threads = [{"name": n, "preview": p, "time_label": "1분", "unread": u} for n, p, u in rows]
    return {"account": account, "folder": folder,
            "unread_total": total if total is not None else sum(1 for r in rows if r[2]), "threads": threads}


@pytest.fixture
def mapped(db):
    db.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'da','DA Clinic','CDA','TOK','x')")
    return db


def notices(db):
    return db.execute("SELECT thread_name, preview, folder, client_id, slack_status FROM notices ORDER BY id").fetchall()


def base(db, routes, *folders, account="daclinic_en"):
    """First snapshot of a list is a silent baseline."""
    for f in folders or ("primary",):
        ingest(db, payload(folder=f, account=account), routes)


def test_first_snapshot_is_a_silent_baseline(mapped):
    routes = {"daclinic_en": 1}
    assert ingest(mapped, payload(("Old", "unread since last week", True)), routes) == []
    ingest(mapped, payload(("Old", "unread since last week", True), ("Madalina", "Hi Evan!", True)), routes)
    assert [r["thread_name"] for r in notices(mapped)] == ["Madalina"]


def test_new_unread_rows_become_notices_once(mapped):
    db = mapped
    routes = {"daclinic_en": 1}
    base(db, routes)
    ingest(db, payload(("Madalina", "Hi Evan!", True), ("Valerie", "Hello", False)), routes)
    ingest(db, payload(("Madalina", "Hi Evan!", True), ("Valerie", "Hello", False)), routes)
    assert [tuple(r) for r in notices(db)] == [("Madalina", "Hi Evan!", "primary", 1, "pending")]


def test_new_preview_on_still_unread_thread_is_a_new_notice(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes)
    ingest(mapped, payload(("Madalina", "Hi", True)), routes)
    ingest(mapped, payload(("Madalina", "Are you there?", True)), routes)
    assert [r[1] for r in notices(mapped)] == ["Hi", "Are you there?"]


def test_read_then_unread_again_notifies(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes)
    ingest(mapped, payload(("Linda", "Hi", True)), routes)
    ingest(mapped, payload(("Linda", "Hi", False)), routes)  # staff opened it
    ingest(mapped, payload(("Linda", "Hi", True)), routes)  # same text again later
    assert len(notices(mapped)) == 2


def test_own_reply_and_read_rows_never_notify(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes)
    ingest(mapped, payload(("Linda", "Hi", False)), routes)
    ingest(mapped, payload(("Linda", "You: see you then", False)), routes)
    assert notices(mapped) == []


def test_general_folder_and_unmapped_account(mapped):
    base(mapped, {"daclinic_en": 1}, "general", account="other_acct")
    ingest(mapped, payload(("Mia", "Thanks", True), folder="general", account="other_acct"), {"daclinic_en": 1})
    r = notices(mapped)[0]
    assert (r["folder"], r["client_id"], r["slack_status"]) == ("general", None, "skipped")


def test_requests_folder_is_recorded_but_never_alerts(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes, "requests")
    ingest(mapped, payload(("Spam", "hey", True), folder="requests"), routes)
    assert notices(mapped) == []


def test_unread_total_counts_latest_snapshot_of_each_folder(mapped):
    routes = {"daclinic_en": 1}
    ingest(mapped, payload(("A", "x", True), ("B", "y", True), ("C", "z", False)), routes)
    ingest(mapped, payload(("G", "g", True), folder="general"), routes)
    assert summary(mapped)["instagram"][0]["unread_total"] == 3
    ingest(mapped, payload(("B", "y", True)), routes)  # A scrolled out of the visible list / was read
    assert summary(mapped)["instagram"][0]["unread_total"] == 2


async def test_one_message_per_burst_with_new_and_unread_counts(mapped):
    routes = {"daclinic_en": 1}
    ingest(mapped, payload(("Old1", "a", True), ("Old2", "b", True)), routes)  # baseline: 2 already unread
    base(mapped, routes, "general")
    ingest(mapped, payload(("Old1", "a", True), ("Old2", "b", True), ("Madalina", "Hi Evan!", True)), routes)
    ingest(mapped, payload(("Mia", "Price?", True), folder="general"), routes)
    p = FakePoster()
    await NoticeSender(mapped, p, tokens={"TOK": "xoxb"}).tick()
    assert len(p.posts) == 1
    text = p.posts[0][2]
    assert text.splitlines()[:3] == ["*새로운 인스타 DM이 있습니다* · @daclinic_en", "• 새로운 알림: 2건", "• 확인하지 않은 알림: 4건"]
    assert "> *Madalina (Primary)*: Hi Evan!" in text and "> *Mia (General)*: Price?" in text
    assert {r["slack_status"] for r in notices(mapped)} == {"sent"}
    await NoticeSender(mapped, p, tokens={"TOK": "xoxb"}).tick()
    assert len(p.posts) == 1


def test_same_name_in_primary_and_general_do_not_disturb_each_other(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes, "primary", "general")
    ingest(mapped, payload(("Kim", "old chat", False)), routes)
    ingest(mapped, payload(("Kim", "new question", True), folder="general"), routes)
    for _ in range(3):  # the two tabs keep reporting in turn
        ingest(mapped, payload(("Kim", "old chat", False)), routes)
        ingest(mapped, payload(("Kim", "new question", True), folder="general"), routes)
    assert [(r["thread_name"], r["folder"]) for r in notices(mapped)] == [("Kim", "general")]


def test_requests_folder_does_not_count_or_swallow(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes, "primary", "requests")
    ingest(mapped, payload(("Zoe", "hi", True), ("Spam", "x", True), folder="requests"), routes)
    assert summary(mapped)["instagram"][0]["unread_total"] == 0
    ingest(mapped, payload(("Zoe", "hi", True)), routes)  # accepted: now shows in Primary
    assert [(r["thread_name"], r["folder"]) for r in notices(mapped)] == [("Zoe", "primary")]
    assert summary(mapped)["instagram"][0]["unread_total"] == 1


def test_half_loaded_list_right_after_opening_is_still_baseline(mapped):
    routes = {"daclinic_en": 1}
    assert ingest(mapped, payload(), routes, settle_sec=20) == []  # page just opened: no rows yet
    assert ingest(mapped, payload(("Old1", "a", True), ("Old2", "b", True)), routes, settle_sec=20) == []
    assert len(ingest(mapped, payload(("Old1", "a", True), ("Old2", "b", True), ("New", "c", True)), routes, settle_sec=0)) == 1


async def test_instagram_counts_conversations_not_preview_changes(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes)
    for text in ("Hi", "Are you there?", "Hello??"):
        ingest(mapped, payload(("Madalina", text, True)), routes)
    p = FakePoster()
    await NoticeSender(mapped, p, tokens={"TOK": "xoxb"}).tick()
    text = p.posts[0][2]
    assert "• 새로운 알림: 1건" in text and "• 확인하지 않은 알림: 1건" in text and "Hello??" in text and "> *Madalina (Primary)*: Hi" not in text


async def test_api_error_budget_is_per_notice_and_offline_never_gives_up(mapped):
    from app.slack.sender import Definite

    routes = {"daclinic_en": 1}
    base(mapped, routes)
    ingest(mapped, payload(("A", "x", True)), routes)
    s = NoticeSender(mapped, FakePoster([Definite("gaierror")] * 3 + [Definite("channel_not_found")] * 2), tokens={"TOK": "xoxb"}, max_attempts=2)

    async def again():
        mapped.execute("UPDATE notices SET next_attempt_at=NULL WHERE slack_status='retry'")
        await s.tick()

    for _ in range(3):
        await again()  # Mac offline: waits, does not burn attempts
    assert [tuple(r) for r in mapped.execute("SELECT slack_status, attempts FROM notices")] == [("retry", 0)]
    await again()
    ingest(mapped, payload(("A", "x", True), ("B", "y", True)), routes)  # joins the failing burst late
    await again()
    assert [tuple(r) for r in mapped.execute("SELECT thread_name, slack_status, attempts FROM notices ORDER BY id")] == [
        ("A", "failed", 2), ("B", "retry", 1)]


async def test_post_interrupted_by_a_crash_is_left_unconfirmed_not_resent(mapped):
    routes = {"daclinic_en": 1}
    base(mapped, routes)
    ingest(mapped, payload(("A", "x", True)), routes)

    class Dies(FakePoster):
        def post(self, token, channel, text):
            raise KeyboardInterrupt  # process killed while the request is in flight

    with pytest.raises(KeyboardInterrupt):
        await NoticeSender(mapped, Dies(), tokens={"TOK": "xoxb"}).tick()
    p = FakePoster()
    s = NoticeSender(mapped, p, tokens={"TOK": "xoxb"})
    assert s.recover() == 1 and s.recover() == 0
    await s.tick()
    assert p.posts == [] and notices(mapped)[0]["slack_status"] == "unconfirmed"
    assert mapped.execute("SELECT count(*) FROM ops_events WHERE kind='slack_unconfirmed'").fetchone()[0] == 1


async def test_notice_sender_posts_escaped_text_to_client_channel(mapped):
    base(mapped, {"daclinic_en": 1})
    ingest(mapped, payload(("<!channel>", "Hi <@U1>", True)), {"daclinic_en": 1})
    p = FakePoster()
    await NoticeSender(mapped, p, tokens={"TOK": "xoxb"}).tick()
    tok, ch, text = p.posts[0]
    assert (tok, ch) == ("xoxb", "CDA") and "인스타" in text and "<!channel>" not in text and "&lt;@U1&gt;" in text
    assert notices(mapped)[0]["slack_status"] == "sent"


async def test_notice_sender_timeout_is_not_resent(mapped):
    base(mapped, {"daclinic_en": 1})
    ingest(mapped, payload(("A", "x", True)), {"daclinic_en": 1})
    p = FakePoster([Uncertain("timeout")])
    s = NoticeSender(mapped, p, tokens={"TOK": "xoxb"})
    await s.tick()
    await s.tick()
    assert notices(mapped)[0]["slack_status"] == "unconfirmed" and p.posts == []


async def test_rate_limit_keeps_the_burst_for_one_later_message(mapped):
    from app.slack.sender import RateLimited

    base(mapped, {"daclinic_en": 1})
    ingest(mapped, payload(("A", "x", True)), {"daclinic_en": 1})
    p = FakePoster([RateLimited(0)])
    s = NoticeSender(mapped, p, tokens={"TOK": "xoxb"})
    await s.tick()
    ingest(mapped, payload(("A", "x", True), ("B", "y", True)), {"daclinic_en": 1})
    await s.tick()
    assert len(p.posts) == 1 and "• 새로운 알림: 2건" in p.posts[0][2]


def test_ingest_endpoint_requires_token(db_path, monkeypatch):
    monkeypatch.setenv("INGEST_TOKEN", "t" * 32)
    factory = lambda: connect(db_path)  # noqa: E731
    app = create_app(factory, SessionAuth("pw", "s" * 40, 3600), Bus(factory), instagram_routes={}, instagram_settle_sec=0)
    c = TestClient(app)
    body = payload(("A", "x", True))
    hdr = {"X-LW-Ingest-Token": "t" * 32}
    assert c.post("/api/ingest/instagram", json=payload(), headers=hdr).json()["new"] == 0  # baseline
    assert c.post("/api/ingest/instagram", json=body).status_code == 401
    assert c.post("/api/ingest/instagram", json=body, headers={"X-LW-Ingest-Token": "wrong"}).status_code == 401
    r = c.post("/api/ingest/instagram", json=body, headers={"X-LW-Ingest-Token": "t" * 32})
    assert r.status_code == 200 and r.json()["new"] == 1
    bad = {**body, "threads": [{"name": "x"}] * 1000}
    assert c.post("/api/ingest/instagram", json=bad, headers={"X-LW-Ingest-Token": "t" * 32}).status_code == 422


def test_ingest_disabled_without_token(db_path, monkeypatch):
    monkeypatch.delenv("INGEST_TOKEN", raising=False)
    factory = lambda: connect(db_path)  # noqa: E731
    c = TestClient(create_app(factory, SessionAuth("pw", "s" * 40, 3600), Bus(factory)))
    assert c.post("/api/ingest/instagram", json=payload()).status_code == 503


def test_client_without_slack_channel_is_skipped(db):
    db.execute("INSERT INTO clients(id,key,name,created_at) VALUES (5,'noslack','No Slack','x')")
    ingest(db, payload(), {"daclinic_en": 5})
    ingest(db, payload(("A", "x", True)), {"daclinic_en": 5})
    assert notices(db)[0]["slack_status"] == "skipped"
