"""WhatsApp list-only watcher: notices with counts, and proof that it never touches the app."""
import copy
import json
import re
from datetime import date, datetime
from pathlib import Path

import pytest

from app import config
from app.collector import ax_reader
from app.collector.ax_backend import AXCallError, FakeBackend
from app.collector.ax_reader import AXReader
from app.collector.wa_rules import WhatsAppRules
from app.notices.core import NoticeSender
from app.notices.whatsapp import WhatsAppWatcher, parse_row
from tests.test_slack import FakePoster

ROOT = Path(__file__).resolve().parent.parent
FIX = json.loads((ROOT / "tests" / "fixtures" / "ax" / "whatsapp_ko.json").read_text())
NOW = datetime(2026, 11, 9, 15, 6)
KIM = [0, 0, 0, 1, 0, 1, 0, 0, 2]  # inbound row "김민수" in the fixture
ME = [0, 0, 0, 1, 0, 1, 0, 0, 3]  # row whose last message is ours (exposed twice: 3 and 4)


class ReadOnlyBackend(FakeBackend):
    """Any attempt to act on WhatsApp fails the test."""

    def perform(self, path, action, expect_role=None):
        raise AssertionError(f"watcher tried to perform {action}")

    def set(self, path, attr, value, expect_role=None):
        raise AssertionError(f"watcher tried to set {attr}")


def node(backend, path):
    return backend._node(path)


def row(value, name="김민수", **extra):
    return {"role": "AXButton", "attrs": {"AXDescription": name, "AXValue": value, "AXHelp": "‎대화를 열려면 두 번 탭하세요", **extra},
            "children": []}


@pytest.fixture
def watch(db, monkeypatch):
    monkeypatch.setattr(ax_reader, "screen_locked", lambda: False)
    db.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'a','A 클리닉','CA','TOK','x')")
    db.execute("INSERT INTO accounts(id,client_id,key,label,collect_method) VALUES (1,1,'a-wa1','A 상담 계정','ax')")
    backend = ReadOnlyBackend(copy.deepcopy(FIX))
    reader = AXReader(backend, WhatsAppRules(today=lambda: NOW.date()))
    w = WhatsAppWatcher(db, reader, account_id=1, account_key="a-wa1", client_id=1, now=lambda: NOW)
    return w, backend, db


def notices(db):
    return [tuple(r) for r in db.execute("SELECT thread_name, preview, new_count, slack_status FROM notices ORDER BY id")]


async def slack_text(db):
    p = FakePoster()
    await NoticeSender(db, p, tokens={"TOK": "xoxb"}).tick()
    return [t for _, _, t in p.posts]


# ------------------------------------------------------------------ row parsing
def test_parse_inbound_row_from_real_wording():
    r = parse_row(row("‎메시지, 내일 예약 가능할까요?, 년 11월 9일 오후 3:05, ‎김민수님께 받았습니다"), date(2026, 11, 9))
    assert (r.name, r.direction, r.preview, r.unread) == ("김민수", "inbound", "내일 예약 가능할까요?", 0)
    assert r.sent_at == datetime(2026, 11, 9, 15, 5)


@pytest.mark.parametrize("wording,count", [
    ("읽지 않은 메시지 3개, ", 3), ("3개의 읽지 않은 메시지, ", 3), ("3 unread messages, ", 3), ("읽지 않음, ", 1),
])
def test_unread_wording_before_the_message(wording, count):
    r = parse_row(row(f"‎{wording}메시지, 안녕하세요, 오후 3:05, ‎김민수님께 받았습니다"), date(2026, 11, 9))
    assert (r.unread, r.direction, r.preview) == (count, "inbound", "안녕하세요")


def test_unread_wording_after_the_message_or_in_a_child():
    tail = parse_row(row("‎메시지, 안녕, 오후 3:05, ‎김민수님께 받았습니다, 읽지 않은 메시지 2개"), date(2026, 11, 9))
    child = row("‎메시지, 안녕, 오후 3:05, ‎김민수님께 받았습니다")
    child["children"] = [{"role": "AXStaticText", "attrs": {"AXValue": "읽지 않은 메시지 4개"}, "children": []}]
    assert tail.unread == 2 and parse_row(child, date(2026, 11, 9)).unread == 4


def test_customer_text_mentioning_unread_is_not_a_badge():
    r = parse_row(row("‎메시지, I have 5 unread messages 읽지 않음, 오후 3:05, ‎김민수님께 받았습니다"), date(2026, 11, 9))
    assert r.unread == 0 and r.preview == "I have 5 unread messages 읽지 않음"


def test_unknown_message_wording_is_the_customers_unless_clearly_ours():
    theirs = parse_row(row("‎메시지, 사진, 오후 3:05"), date(2026, 11, 9))
    ours = parse_row(row("‎내 메시지, 사진, 오후 3:05"), date(2026, 11, 9))
    assert (theirs.direction, theirs.stable, ours.direction) == ("inbound", True, "outbound")


def test_text_that_is_not_a_message_sentence_is_marked_unstable():
    assert parse_row(row("‎입력 중…"), date(2026, 11, 9)).stable is False


def test_cursor_ignores_date_wording_delivery_status_and_badge():
    d = date(2026, 11, 9)
    base = parse_row(row("‎메시지, 안녕, 오후 3:05, ‎김민수님께 받았습니다"), d).cursor
    assert base == parse_row(row("‎메시지, 안녕, 어제 오후 3:05, ‎김민수님께 받았습니다"), date(2026, 11, 10)).cursor
    assert base == parse_row(row("‎메시지, 안녕, 년 11월 9일 오후 3:05, ‎김민수님께 받았습니다"), date(2026, 11, 20)).cursor
    assert base == parse_row(row("‎메시지, 안녕, 오후 3:05, ‎김민수님께 받았습니다, 읽지 않은 메시지 1개"), d).cursor
    assert base == parse_row(row("‎읽지 않은 메시지 1개, 메시지, 안녕, 오후 3:05, ‎김민수님께 받았습니다"), d).cursor
    sent = parse_row(row("‎내 메시지, 네, 오후 3:05, ‎김민수님께 보냈습니다., ‎전송됨"), d).cursor
    assert sent == parse_row(row("‎내 메시지, 네, 오후 3:05, ‎김민수님께 보냈습니다., ‎읽음"), d).cursor
    unknown = parse_row(row("‎메시지, 사진, 오후 3:05"), d).cursor
    assert unknown == parse_row(row("‎메시지, 사진, 어제 오후 3:05, 읽지 않은 메시지 2개"), d).cursor


# ------------------------------------------------------------------ watcher
def test_first_look_is_silent_then_new_customer_message_notifies(watch):
    w, backend, db = watch
    assert w.tick() == [] and notices(db) == []
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 3시에 갈게요, 오후 3:06, ‎김민수님께 받았습니다"
    w.tick()
    w.tick()  # unchanged list: no repeat
    assert notices(db) == [("김민수", "3시에 갈게요", 1, "pending")]


async def test_without_a_visible_badge_only_the_new_count_is_claimed(watch):
    w, backend, db = watch
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 3시에 갈게요, 오후 3:06, ‎김민수님께 받았습니다"
    w.tick()
    (text,) = await slack_text(db)
    assert text.splitlines()[:2] == ["*새로운 왓츠앱 알림이 있습니다* · A 상담 계정", "• 새로운 알림: 1건"]
    assert "확인하지 않은" not in text and "> *김민수*: 3시에 갈게요" in text


async def test_new_and_unread_counts_when_badges_are_readable(watch):
    w, backend, db = watch
    rows = node(backend, KIM[:-1])["children"]
    rows.append(row("‎읽지 않은 메시지 2개, 메시지, 예전 문의, 어제 오후 1:00, ‎이영희님께 받았습니다", name="이영희"))
    w.tick()  # baseline: 이영희 already has 2 unread
    node(backend, KIM)["attrs"]["AXValue"] = "‎읽지 않은 메시지 2개, 메시지, 두 번째, 오후 3:06, ‎김민수님께 받았습니다"
    w.tick()
    assert notices(db) == [("김민수", "두 번째", 2, "pending")]
    (text,) = await slack_text(db)
    assert text.splitlines()[1:3] == ["• 새로운 알림: 2건", "• 확인하지 않은 알림: 4건"]


def test_same_text_again_is_caught_by_the_badge_growing(watch):
    w, backend, db = watch
    node(backend, KIM)["attrs"]["AXValue"] = "‎읽지 않은 메시지 1개, 메시지, 네, 오후 3:05, ‎김민수님께 받았습니다"
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎읽지 않은 메시지 2개, 메시지, 네, 오후 3:05, ‎김민수님께 받았습니다"
    w.tick()
    assert notices(db) == [("김민수", "네", 1, "pending")]


def test_staff_reply_and_reading_on_the_phone_do_not_notify(watch):
    w, backend, db = watch
    node(backend, KIM)["attrs"]["AXValue"] = "‎읽지 않은 메시지 1개, 메시지, 네, 오후 3:05, ‎김민수님께 받았습니다"
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 네, 오후 3:05, ‎김민수님께 받았습니다"  # read on the phone
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎내 메시지, 예약해 드렸어요, 오후 3:07, ‎김민수님께 보냈습니다., ‎전송됨"
    w.tick()
    for p in (ME, ME[:-1] + [4]):
        node(backend, p)["attrs"]["AXValue"] = node(backend, p)["attrs"]["AXValue"].replace("‎읽음", "‎전송됨")
    w.tick()
    assert notices(db) == []


def test_typing_indicator_or_draft_text_is_not_a_new_message(watch):
    w, backend, db = watch
    w.tick()
    original = node(backend, KIM)["attrs"]["AXValue"]
    for value in ("‎입력 중…", original, "‎초안: 안녕하세요", original):
        node(backend, KIM)["attrs"]["AXValue"] = value
        w.tick()
    for p in (ME, ME[:-1] + [4]):
        node(backend, p)["attrs"]["AXValue"] = "‎입력 중…"
    w.tick()
    assert notices(db) == []


def test_badge_wording_after_the_sentence_disappearing_is_not_a_new_message(watch):
    w, backend, db = watch
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 네, 오후 3:05, ‎김민수님께 받았습니다, 읽지 않은 메시지 1개"
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 네, 오후 3:05, ‎김민수님께 받았습니다"  # read on the phone
    w.tick()
    assert notices(db) == []


def test_old_unread_chat_coming_into_view_does_not_notify(watch):
    w, backend, db = watch
    w.tick()
    rows = node(backend, KIM[:-1])["children"]
    rows.append(row("‎읽지 않은 메시지 2개, 메시지, 지난달 문의, 년 10월 2일 오후 1:00, ‎박철수님께 받았습니다", name="박철수"))
    w.tick()
    assert notices(db) == []
    assert db.execute("SELECT unread_total FROM notice_accounts WHERE channel='whatsapp'").fetchone()[0] == 2


def test_brand_new_chat_notifies_but_an_old_chat_scrolling_in_does_not(watch):
    w, backend, db = watch
    w.tick()
    rows = node(backend, KIM[:-1])["children"]
    rows.append(row("‎메시지, 처음 문의드려요, 오후 3:06, ‎+ 8 2,1 0,1 2 3 4,5 6 7 8님께 받았습니다", name="+ 8 2,1 0,1 2 3 4,5 6 7 8"))
    rows.append(row("‎메시지, 지난달 문의, 년 10월 2일 오후 1:00, ‎박철수님께 받았습니다", name="박철수"))
    w.tick()
    assert notices(db) == [("+821012345678", "처음 문의드려요", 1, "pending")]


def test_excluded_chat_is_ignored(watch):
    w, backend, db = watch
    w.exclude = {"김민수"}
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 새 글, 오후 3:06, ‎김민수님께 받았습니다"
    w.tick()
    assert notices(db) == []


def test_locked_screen_or_missing_permission_reads_nothing_and_is_reported_once(watch, monkeypatch):
    w, backend, db = watch
    monkeypatch.setattr(ax_reader, "screen_locked", lambda: True)
    assert w.tick() == [] and w.tick() == []
    assert db.execute("SELECT status FROM accounts").fetchone()[0] == "locked"
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='account_status'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM notice_folders").fetchone()[0] == 0


# ------------------------------------------------------------------ account safety (requirement 3)
def test_watcher_never_acts_on_whatsapp(watch):
    """ReadOnlyBackend raises on perform/set; a whole cycle with changes must stay read-only."""
    w, backend, db = watch
    w.tick()
    node(backend, KIM)["attrs"]["AXValue"] = "‎메시지, 3시에 갈게요, 오후 3:06, ‎김민수님께 받았습니다"
    w.tick()
    assert backend.performed == [] and len(notices(db)) == 1


def test_notify_module_has_no_way_to_act_on_whatsapp():
    src = (ROOT / "app" / "notices" / "whatsapp.py").read_text()
    assert not re.search(r"\.perform\(|\.set\(|read_messages|_open\(", src)


def test_stale_tree_does_not_crash_the_watcher(watch):
    w, backend, db = watch
    backend.snapshot = lambda *a, **k: (_ for _ in ()).throw(AXCallError("stale"))
    assert w.tick() == []
    assert db.execute("SELECT status FROM accounts").fetchone()[0] == "unknown"


def test_instagram_extension_only_reads_the_page():
    """No clicks, no typing, no navigation, and no requests of its own to instagram.com."""
    content = (ROOT / "chrome-extension" / "content.js").read_text()
    assert not re.search(r"\.click\(|dispatchEvent|fetch\(|XMLHttpRequest|\.focus\(|\.submit\(|location\.(href|assign|replace|reload)|scroll(To|By|IntoView)", content)
    background = (ROOT / "chrome-extension" / "background.js").read_text()
    assert background.count("fetch(") == 1 and "/api/ingest/instagram" in background and "instagram.com" not in background
    manifest = json.loads((ROOT / "chrome-extension" / "manifest.json").read_text())
    assert set(manifest["permissions"]) <= {"storage", "alarms"}  # no cookies, webRequest, tabs, scripting


# ------------------------------------------------------------------ config
def test_whatsapp_accounts_default_to_notify_mode(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text("""
server: {host: 127.0.0.1, auth: none}
clients:
  - key: a
    name: A
    accounts:
      - {key: a1}
      - {key: a2, mode: collect}
      - {key: a3, collect_method: fake, session_key: x.json}
""")
    cfg = config.load(p, env_path=None)
    cfg.validate()
    assert [a.mode for a in cfg.clients[0].accounts] == ["notify", "collect", "collect"]
    p.write_text(p.read_text().replace("mode: collect", "mode: both"))
    with pytest.raises(ValueError):
        config.load(p, env_path=None).validate()
