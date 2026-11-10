import json
from datetime import date
from pathlib import Path

import pytest

from app.collector.ax_backend import FakeBackend
from app.collector.contract import ObservedConversation
from app.collector.wa_rules import WhatsAppRules, normalize_name, parse_bubble

FIX = json.loads((Path(__file__).parent / "fixtures" / "ax" / "whatsapp_ko.json").read_text())
TODAY = date(2026, 11, 9)


def rules():
    return WhatsAppRules(today=lambda: TODAY, open_timeout=0.2)


def test_normalize_phone_forms_match():
    assert normalize_name("+ 1,5 5 5,1 2 3,4 5 6 7") == "+15551234567"
    assert normalize_name("‪+1 (555) 123‑4567‬") == "+15551234567"
    assert normalize_name("‎김민수") == "김민수"


def test_parse_inbound_multiline_with_commas():
    m = parse_bubble("‎메시지, Price, list, please, 년 11월 9일 오전 11:39, ‎+ 1,5 5 5님께 받았습니다", TODAY)
    assert (m.direction, m.body, m.shown_date_hint, m.shown_time) == ("inbound", "Price, list, please", "2026-11-09", "11:39")


def test_parse_outbound_status_ignored_and_pm():
    m = parse_bubble("‎내 메시지, Yes, 3pm works, 년 11월 9일 오후 12:40, ‎X님께 보냈습니다., ‎읽음", TODAY)
    assert (m.direction, m.body, m.shown_time) == ("outbound", "Yes, 3pm works", "12:40")
    m2 = parse_bubble("‎내 메시지, a, 년 11월 9일 오전 12:05, ‎X님께 보냈습니다., ‎전송됨", TODAY)
    assert m2.shown_time == "00:05"


def test_body_containing_a_date_keeps_it():
    m = parse_bubble("‎메시지, 12월 31일 오후 3:00 가능?, 년 12월 30일 오후 12:05, ‎X님께 받았습니다", TODAY)
    assert m.body == "12월 31일 오후 3:00 가능?"
    assert m.shown_date_hint == "2025-12-30"  # later than today -> previous year


def test_system_and_unparseable():
    sysmsg = parse_bubble("\u200e이 비즈니스는 이제 Meta의 안전한 서비스를 이용합니다.", TODAY)
    assert (sysmsg.direction, sysmsg.kind) == ("system", "text")
    odd = parse_bubble("‎메시지, 무언가, 형식이 다름", TODAY)
    assert odd.direction == "unknown" and "unparsed_bubble" in odd.flags


def test_prefix_suffix_disagreement_is_unknown():
    m = parse_bubble("‎내 메시지, x, 년 11월 9일 오전 9:00, ‎X님께 받았습니다", TODAY)
    assert m.direction == "unknown"


def test_list_conversations_dedupes_selected_row():
    convs = rules().list_conversations(FakeBackend(FIX))
    assert [c.display_name for c in convs] == ["김민수", "+15551234567"]
    assert convs[0].list_cursor and "내일 예약" in convs[0].list_cursor


def test_read_open_conversation_without_clicking():
    b = FakeBackend(FIX)
    r = rules()
    cur = r.current_conversation(b)
    assert cur.display_name == "+15551234567"
    win = r.read_messages(b, cur, 30)
    assert b.performed == []
    got = [(m.direction, m.body, m.shown_date_hint, m.shown_time) for m in win.messages]
    assert got[0] == ("inbound", "Hi, how much is botox?\nAnd do you have parking?", "2026-11-08", "23:58")
    assert got[1] == got[2] == ("outbound", "네", "2026-11-09", "09:01")
    assert ("system", "이 비즈니스는 이제 Meta의 안전한 서비스를 이용하여 대화를 관리합니다.", None, None) in got
    assert len(got) == 7  # the empty date heading is not a message


def test_read_other_conversation_presses_its_row():
    b = FakeBackend(FIX)
    r = rules()
    with pytest.raises(Exception):
        r.read_messages(b, ObservedConversation("김민수"), 30)  # fake tree doesn't change after the press
    assert b.performed and b.performed[0][2] == "AXPress"


def test_connection_state():
    assert rules().connection_state(FakeBackend(FIX)).state == "ok"
    empty = {"path": [], "role": "AXApplication", "attrs": {}, "frame": None, "children": []}
    assert rules().connection_state(FakeBackend(empty)).state == "unknown"


def test_today_message_has_no_date_part():
    m = parse_bubble("‎내 메시지, test gogo, 오후 11:53, ‎+ 1,5 5 5님께 보냈습니다., ‎전송됨", TODAY)
    assert (m.direction, m.body, m.shown_date_hint, m.shown_time) == ("outbound", "test gogo", "2026-11-09", "23:53")


def test_yesterday_and_weekday_labels():
    y = parse_bubble("‎메시지, hi, 어제 오전 9:05, ‎X님께 받았습니다", TODAY)
    assert (y.direction, y.shown_date_hint, y.shown_time) == ("inbound", "2026-11-08", "09:05")
    w = parse_bubble("‎메시지, hi, 금요일 오후 2:00, ‎X님께 받았습니다", TODAY)  # 2026-11-09 is a Monday
    assert w.shown_date_hint == "2026-11-06"


def test_body_with_time_text_on_today_message():
    m = parse_bubble("‎메시지, 오후 3:00, 가능해요?, 오후 11:50, ‎X님께 받았습니다", TODAY)
    assert (m.body, m.shown_time) == ("오후 3:00, 가능해요?", "23:50")
