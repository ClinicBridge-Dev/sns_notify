import pytest
from fastapi.testclient import TestClient

from app.api.auth import SessionAuth
from app.api.bus import Bus
from app.api.server import create_app
from app.api import instagram_admin
from app.db.repo import connect
from app.notices.core import NoticeSender
from tests.test_instagram import payload
from tests.test_slack import FakePoster

HEADERS = {'X-Requested-With': 'sns-notify'}
INGEST = {'X-LW-Ingest-Token': 't' * 32}


class FakeSlack:
    def auth_test(self):
        return {'team': 'Test workspace'}

    def users_conversations(self, **kwargs):
        if not kwargs.get('cursor'):
            return {'channels': [{'id': 'CONE', 'name': 'one'}], 'response_metadata': {'next_cursor': 'next'}}
        return {'channels': [{'id': 'CTWO', 'name': 'two', 'is_private': True}]}

    def conversations_info(self, channel):
        return {'channel': {'id': channel, 'name': channel.lower(), 'is_member': channel != 'CNO', 'is_archived': channel == 'COLD'}}


@pytest.fixture
def setup(db_path, monkeypatch):
    monkeypatch.setenv('INGEST_TOKEN', 't' * 32)
    monkeypatch.setenv('SLACK_TOKEN_MAIN', 'secret-not-for-browser')
    monkeypatch.setattr(instagram_admin, 'token_refs', lambda conn: ['SLACK_TOKEN_MAIN'])
    monkeypatch.setattr(instagram_admin, 'slack_client', lambda ref: FakeSlack())
    conn = connect(db_path)
    conn.execute("INSERT INTO clients(id,key,name,slack_channel_id,slack_token_ref,created_at) VALUES (1,'old','Old','CONE','SLACK_TOKEN_MAIN','x')")
    conn.close()

    def make():
        factory = lambda: connect(db_path)
        return TestClient(create_app(factory, SessionAuth('pw', 's' * 40, 3600), Bus(factory),
                                     instagram_routes={'existing': 1}, instagram_settle_sec=0))
    client = make()
    client.post('/api/login', json={'password': 'pw'})
    return client, make


def test_auth_csrf_and_discovered_accounts(setup):
    client, make = setup
    anon = make()
    assert anon.get('/api/manage/instagram').status_code == 401
    assert anon.get('/api/manage/slack-channels').status_code == 401
    assert anon.put('/api/manage/instagram/existing', json={}).status_code == 401
    assert client.put('/api/manage/instagram/existing', json={}).status_code == 403
    assert client.put('/api/manage/instagram/existing', json={}, headers={**HEADERS, 'Origin': 'https://evil.test'}).status_code == 403
    assert client.put('/api/manage/instagram/unknown', json={}, headers=HEADERS).status_code == 404
    client.post('/api/ingest/instagram', json=payload(account='new_account'), headers=INGEST)
    data = client.get('/api/manage/instagram').json()
    assert {a['account']: a['state'] for a in data['accounts']} == {'existing': 'connected', 'new_account': 'unmapped'}
    assert 'secret-not-for-browser' not in str(data)


def test_channel_pagination_and_validation(setup):
    client, _ = setup
    data = client.get('/api/manage/slack-channels').json()
    assert {c['id'] for c in data['channels']} == {'CONE', 'CTWO'}
    assert 'secret-not-for-browser' not in str(data)
    for channel in ('CNO', 'COLD'):
        r = client.put('/api/manage/instagram/existing', json={'channel_id': channel, 'token_ref': 'SLACK_TOKEN_MAIN'}, headers=HEADERS)
        assert r.status_code == 400
    assert client.put('/api/manage/instagram/existing', json={'channel_id': 'D123', 'token_ref': 'SLACK_TOKEN_MAIN'}, headers=HEADERS).status_code == 422
    assert client.put('/api/manage/instagram/existing', json={'channel_id': 'CONE', 'token_ref': 'UNTRUSTED'}, headers=HEADERS).status_code == 400


@pytest.mark.asyncio
async def test_save_routes_immediately_without_moving_existing_notices(setup, db_path):
    client, make = setup
    client.post('/api/ingest/instagram', json=payload(account='existing'), headers=INGEST)
    client.post('/api/ingest/instagram', json=payload(('A', 'first', True), account='existing'), headers=INGEST)
    assert client.put('/api/manage/instagram/existing', json={'channel_id': 'CTWO', 'token_ref': 'SLACK_TOKEN_MAIN'}, headers=HEADERS).status_code == 200
    response = client.post('/api/ingest/instagram', json=payload(('A', 'second', True), account='existing'), headers=INGEST)
    assert response.json() == {'ok': True, 'new': 1}
    conn = connect(db_path)
    poster = FakePoster(['1.0', '2.0'])
    await NoticeSender(conn, poster).tick()
    assert [p[1] for p in poster.posts] == ['CONE', 'CTWO']
    assert conn.execute('SELECT slack_channel_id FROM clients WHERE id=1').fetchone()[0] == 'CONE'
    conn.close()
    # Recreating the app simulates restart; YAML seeding cannot overwrite a UI selection.
    restarted = make()
    restarted.post('/api/login', json={'password': 'pw'})
    account = restarted.get('/api/manage/instagram').json()['accounts'][0]
    assert account['channel_id'] == 'CTWO'


def test_pause_persists_and_new_account_can_connect(setup):
    client, make = setup
    assert client.put('/api/manage/instagram/existing', json={}, headers=HEADERS).status_code == 200
    restarted = make()
    restarted.post('/api/login', json={'password': 'pw'})
    assert restarted.get('/api/manage/instagram').json()['accounts'][0]['state'] == 'paused'
    restarted.post('/api/ingest/instagram', json=payload(account='existing'), headers=INGEST)
    result = restarted.post('/api/ingest/instagram', json=payload(('A', 'not sent', True), account='existing'), headers=INGEST).json()
    assert result['warning'] == 'instagram_account_unmapped'
    restarted.post('/api/ingest/instagram', json=payload(account='new'), headers=INGEST)
    assert restarted.put('/api/manage/instagram/new', json={'channel_id': 'CTWO', 'token_ref': 'SLACK_TOKEN_MAIN'}, headers=HEADERS).status_code == 200
    result = restarted.post('/api/ingest/instagram', json=payload(('A', 'hello', True), account='new'), headers=INGEST).json()
    assert result == {'ok': True, 'new': 1}
