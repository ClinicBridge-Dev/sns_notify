import pytest
from fastapi.testclient import TestClient

from app.api.auth import SessionAuth
from app.api.bus import Bus
from app.api.server import create_app
from app.db.repo import connect
from tests.test_slack import add_outbox, setup_two_clients


@pytest.fixture
def client(db_path):
    c = connect(db_path)
    setup_two_clients(c)
    add_outbox(c, "Hello A")
    add_outbox(c, "Hi B", client=2)
    c.execute("UPDATE conversations SET last_seq=(SELECT max(conv_seq) FROM messages WHERE conversation_id=conversations.id), last_activity_at='2026-11-09T01:00:00+00:00'")
    c.close()
    factory = lambda: connect(db_path)  # noqa: E731
    auth = SessionAuth("pw-123", "s" * 40, 3600)
    app = create_app(factory, auth, Bus(factory))
    return TestClient(app)


def login(client):
    r = client.post("/api/login", json={"password": "pw-123"})
    assert r.status_code == 200


def test_requires_login(client):
    assert client.get("/api/conversations").status_code == 401
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    login(client)
    assert client.get("/api/me").json() == {"ok": True}


def test_conversations_and_messages(client):
    login(client)
    convs = client.get("/api/conversations").json()
    assert {c["display_name"] for c in convs} == {"Kim", "Lee"}
    kim = next(c for c in convs if c["display_name"] == "Kim")
    assert kim["last_message"]["body_preview"] == "Hello A"
    only_b = client.get("/api/conversations", params={"client_id": 2}).json()
    assert [c["display_name"] for c in only_b] == ["Lee"]
    assert [c["display_name"] for c in client.get("/api/conversations", params={"q": "ki"}).json()] == ["Kim"]
    page = client.get(f"/api/conversations/{kim['id']}/messages").json()
    assert page["has_more"] is False
    m = page["messages"][0]
    assert m["body"] == "Hello A" and m["translation"]["status"] == "done"
    assert client.get("/api/conversations/999/messages").status_code == 404


def test_pagination(client, db_path):
    c = connect(db_path)
    for i in range(5):
        add_outbox(c, f"m{i}")
    c.close()
    login(client)
    p1 = client.get("/api/conversations/1/messages", params={"limit": 3}).json()
    assert p1["has_more"] and [m["body"] for m in p1["messages"]] == ["m2", "m3", "m4"]
    p2 = client.get("/api/conversations/1/messages", params={"limit": 3, "before": p1["messages"][0]["seq"]}).json()
    assert [m["body"] for m in p2["messages"]] == ["Hello A", "m0", "m1"] and not p2["has_more"]


def test_status(client):
    login(client)
    s = client.get("/api/status").json()
    assert s["slack"]["pending"] == 2 and len(s["accounts"]) == 2


def test_no_write_endpoints(client):
    writes = set()
    for r in client.app.routes:
        for m in getattr(r, "methods", set()) or set():
            if m not in ("GET", "HEAD"):
                writes.add((r.path, m))
    # the only other write is token-authenticated ingest from the Chrome extension (Instagram notices)
    assert writes == {("/api/login", "POST"), ("/api/logout", "POST"), ("/api/ingest/instagram", "POST")}


def test_login_throttle(client):
    for _ in range(10):
        client.post("/api/login", json={"password": "x"})
    assert client.post("/api/login", json={"password": "pw-123"}).status_code == 429


def test_static_path_traversal_blocked(client):
    r = client.get("/../../config.yaml")
    assert "VIEWER_PASSWORD" not in r.text


def test_list_preview_skips_system_notices(client, db_path):
    c = connect(db_path)
    c.execute(
        """INSERT INTO messages(client_id,account_id,conversation_id,conv_seq,direction,kind,body,time_precision,observed_at,
           collect_mode,confidence,content_key,fingerprint,seq_in_batch,created_at)
           VALUES (1,1,1,99,'system','text','이 비즈니스는 이제 Meta의 …','unknown','x','baseline','review','k','fsys',0,'x')"""
    )
    c.execute("UPDATE conversations SET last_seq=99 WHERE id=1")
    c.close()
    login(client)
    kim = next(x for x in client.get("/api/conversations").json() if x["display_name"] == "Kim")
    assert kim["last_message"]["body_preview"] == "Hello A"
