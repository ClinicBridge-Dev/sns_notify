"""collector -> DB -> translator(mock) -> outbox -> sender(fake) in one pass, plus SSE bus."""
import asyncio
import json
from pathlib import Path

from app.api.bus import Bus
from app.collector.contract import FakeReader, ObservedMessage
from app.collector.loop import AccountCollector
from app.db.repo import connect
from app.slack.sender import SlackSender
from app.translator.gpt import TranslationResult
from app.translator.worker import TranslatorWorker
from tests.test_slack import FakePoster

FIX = Path(__file__).parent / "fixtures" / "demo.json"


async def fake_gpt(text):
    return TranslationResult("en", f"[ko] {text}")


async def test_end_to_end(db_path):
    db = connect(db_path)
    db.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'a','A','CA','TOK','x')")
    db.execute("INSERT INTO accounts(id,client_id,key,label,collect_method) VALUES (1,1,'a1','A1','fake')")
    reader = FakeReader.from_json(json.loads(FIX.read_text()))
    bus = Bus(lambda: connect(db_path))
    q = bus.subscribe()
    col = AccountCollector(connect(db_path), reader, account_id=1, client_id=1, recent_window=5, on_new=bus.publish_messages)
    tw = TranslatorWorker(connect(db_path), fake_gpt, model="m")
    poster = FakePoster()
    sender = SlackSender(connect(db_path), poster, tokens={"TOK": "x"}, min_interval_sec=0)

    col.run_pass()  # baseline: stored, never alerted
    await tw.tick()
    await sender.tick()
    assert db.execute("SELECT count(*) FROM messages").fetchone()[0] == 8
    assert poster.posts == []
    assert q.qsize() == 8

    reader.add("Emma (UK)", ObservedMessage("inbound", "text", "Can I pay by card?", "09:05", "2026-11-09"))
    reader.add("Emma (UK)", ObservedMessage("outbound", "text", "네 가능합니다", "09:06", "2026-11-09"))
    reader.add("New Lead", ObservedMessage("inbound", "text", "Price list please", "09:07", "2026-11-09"))
    col.run_pass()
    await tw.tick()
    await sender.tick()
    texts = [t for _, _, t in poster.posts]
    assert len(texts) == 2
    assert any("Can I pay by card?" in t and "[ko] Can I pay by card?" in t for t in texts)
    assert any("New Lead" in t for t in texts)
    assert not any("네 가능합니다" in t for t in texts)

    # restart everything: no duplicates anywhere
    col2 = AccountCollector(connect(db_path), reader, account_id=1, client_id=1, recent_window=5)
    col2.run_pass()
    s2 = SlackSender(connect(db_path), poster, tokens={"TOK": "x"}, min_interval_sec=0)
    s2.recover()
    await s2.tick()
    assert db.execute("SELECT count(*) FROM messages").fetchone()[0] == 11
    assert len(poster.posts) == 2

    ev, data = await asyncio.wait_for(q.get(), 1)
    assert ev == "message" and data["conversation"]["display_name"] in ("Emma (UK)", "田中さん")
