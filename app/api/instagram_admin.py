"""Authenticated Instagram routing management; credentials never leave the server."""
from __future__ import annotations

import hashlib
import os
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from ..db.repo import Tx, ops_event, utcnow


def seed_routes(conn, routes):
    with Tx(conn):
        for account, client_id in routes.items():
            conn.execute("INSERT OR IGNORE INTO instagram_routes(account,client_id,updated_at) VALUES (?,?,?)",
                         (account, client_id, utcnow()))


def active_routes(conn):
    return {r['account']: r['client_id'] for r in conn.execute(
        "SELECT r.account,r.client_id FROM instagram_routes r JOIN clients c ON c.id=r.client_id WHERE c.active=1")}


def token_refs(conn):
    refs = {r[0] for r in conn.execute("SELECT DISTINCT slack_token_ref FROM clients WHERE slack_token_ref IS NOT NULL")}
    refs.update(k for k in os.environ if k.startswith('SLACK_TOKEN_'))
    return sorted(ref for ref in refs if os.environ.get(ref))


def slack_client(ref):
    return WebClient(token=os.environ[ref], timeout=10, retry_handlers=[])


def slack_error(exc):
    if isinstance(exc, SlackApiError):
        code = exc.response.get('error', 'slack_error')
        if code == 'missing_scope':
            return 'Slack 채널 조회 권한이 없습니다. channels:read와 groups:read 추가 후 앱을 재설치해 주세요.'
        if code == 'ratelimited':
            return 'Slack 조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.'
        return f'Slack 연결 확인 실패: {code}'
    return 'Slack에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'


class RouteChange(BaseModel):
    channel_id: str | None = Field(default=None, pattern=r'^[CG][A-Z0-9]{2,}$')
    token_ref: str | None = Field(default=None, max_length=150)


def router(conn_factory):
    api = APIRouter(prefix='/api/manage')

    @api.get('/instagram')
    def accounts():
        conn = conn_factory()
        try:
            names = {r[0] for r in conn.execute("SELECT account FROM notice_folders WHERE channel='instagram'")}
            names.update(r[0] for r in conn.execute('SELECT account FROM instagram_routes'))
            result = []
            for account in sorted(names):
                route = conn.execute('''SELECT r.client_id,c.slack_channel_id,c.slack_token_ref,c.name,c.active
                    FROM instagram_routes r LEFT JOIN clients c ON c.id=r.client_id WHERE r.account=?''', (account,)).fetchone()
                folders = [dict(r) for r in conn.execute("SELECT folder,snapshot_at FROM notice_folders WHERE channel='instagram' AND account=? ORDER BY folder", (account,))]
                latest = conn.execute("SELECT created_at,slack_status,last_error FROM notices WHERE channel='instagram' AND account=? ORDER BY id DESC LIMIT 1", (account,)).fetchone()
                result.append({'account': account, 'folders': folders,
                               'state': 'unmapped' if route is None else ('paused' if route['client_id'] is None else ('connected' if route['active'] else 'inactive')),
                               'channel_id': route['slack_channel_id'] if route else None,
                               'token_ref': route['slack_token_ref'] if route else None,
                               'destination_name': route['name'] if route else None,
                               'latest_notice': dict(latest) if latest else None})
            return {'accounts': result}
        finally:
            conn.close()

    @api.get('/slack-channels')
    def channels():
        conn = conn_factory()
        try:
            refs = token_refs(conn)
        finally:
            conn.close()
        result, errors = [], []
        for ref in refs:
            try:
                client = slack_client(ref)
                identity = client.auth_test()
                cursor = None
                while True:
                    page = client.users_conversations(types='public_channel,private_channel', exclude_archived=True,
                                                      limit=200, cursor=cursor)
                    for channel in page.get('channels', []):
                        if channel.get('is_archived'):
                            continue
                        result.append({'id': channel['id'], 'name': channel.get('name', channel['id']),
                                       'private': bool(channel.get('is_private')), 'token_ref': ref,
                                       'workspace': identity.get('team', ref)})
                    cursor = page.get('response_metadata', {}).get('next_cursor')
                    if not cursor:
                        break
            except Exception as exc:
                errors.append({'token_ref': ref, 'message': slack_error(exc)})
        return {'channels': sorted(result, key=lambda c: (c['workspace'], c['name'])), 'errors': errors}

    @api.put('/instagram/{account}')
    def save(account: str, change: RouteChange, request: Request):
        # A custom header + same-origin request prevents cross-site writes, including in localhost NoAuth mode.
        origin = request.headers.get('origin')
        if request.headers.get('x-requested-with') != 'sns-notify' or (origin and urlsplit(origin).netloc != request.url.netloc):
            raise HTTPException(403, '관리 화면에서 다시 저장해 주세요.')
        conn = conn_factory()
        try:
            known = conn.execute("SELECT 1 FROM notice_folders WHERE channel='instagram' AND account=? UNION SELECT 1 FROM instagram_routes WHERE account=?", (account, account)).fetchone()
            if not known:
                raise HTTPException(404, '아직 감지되지 않은 계정입니다. 해당 계정의 DM 목록을 먼저 열어 주세요.')
            channel = None
            if change.channel_id:
                if change.token_ref not in token_refs(conn):
                    raise HTTPException(400, '사용할 수 없는 Slack 연결입니다.')
                try:
                    channel = slack_client(change.token_ref).conversations_info(channel=change.channel_id)['channel']
                except Exception as exc:
                    raise HTTPException(400, slack_error(exc)) from None
                if channel.get('is_archived') or not channel.get('is_member') or channel.get('is_im') or channel.get('is_mpim'):
                    raise HTTPException(400, '봇이 참여한 활성 채널만 선택할 수 있습니다.')
            with Tx(conn):
                client_id = None
                if channel:
                    # Separate delivery destinations keep other accounts and queued notices unchanged.
                    key = 'ig-destination-' + hashlib.sha256(f'{change.token_ref}:{change.channel_id}'.encode()).hexdigest()[:24]
                    conn.execute('''INSERT INTO clients(key,name,slack_channel_id,slack_token_ref,active,created_at)
                        VALUES (?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name,active=1''',
                        (key, '#' + channel.get('name', change.channel_id), change.channel_id, change.token_ref, utcnow()))
                    client_id = conn.execute('SELECT id FROM clients WHERE key=?', (key,)).fetchone()[0]
                conn.execute('''INSERT INTO instagram_routes(account,client_id,updated_at) VALUES (?,?,?)
                    ON CONFLICT(account) DO UPDATE SET client_id=excluded.client_id,updated_at=excluded.updated_at''',
                    (account, client_id, utcnow()))
                ops_event(conn, 'info', 'instagram_route_changed', f'@{account} -> {change.channel_id or "paused"}')
            return {'ok': True}
        finally:
            conn.close()

    return api
