"""FastAPI app: conversation viewer, authenticated routing management, and ingestion."""
from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sse_starlette.sse import EventSourceResponse
from starlette.middleware.base import BaseHTTPMiddleware

from ..ops.status import summary
from . import dto
import hmac
import os

from ..notices.instagram import SETTLE_SEC, Snapshot, ingest as ingest_instagram
from .auth import COOKIE, PUBLIC_API, TOKEN_API_PREFIX, NoAuth, SessionAuth
from .bus import Bus
from .instagram_admin import active_routes, router as admin_router, seed_routes

STATIC = Path(__file__).resolve().parent.parent / "static"


def create_app(conn_factory: Callable[[], sqlite3.Connection], auth: SessionAuth | NoAuth, bus: Bus,
               status_interval: float = 15, instagram_routes: dict[str, int] | None = None,
               instagram_settle_sec: float = SETTLE_SEC) -> FastAPI:
    app = FastAPI(title="local-whatsapp viewer", docs_url=None, redoc_url=None, openapi_url=None)

    class Guard(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            path = request.url.path
            if (path.startswith("/api/") and path not in PUBLIC_API and not path.startswith(TOKEN_API_PREFIX)
                    and not auth.is_authenticated(request)):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            resp = await call_next(request)
            resp.headers["X-Frame-Options"] = "DENY"
            resp.headers["X-Content-Type-Options"] = "nosniff"
            resp.headers["Referrer-Policy"] = "no-referrer"
            if path.startswith("/api/"):
                resp.headers["Cache-Control"] = "no-store"
            return resp

    app.add_middleware(Guard)

    def db() -> sqlite3.Connection:
        return conn_factory()

    seed_conn = db()
    try:
        seed_routes(seed_conn, instagram_routes or {})
    finally:
        seed_conn.close()
    app.include_router(admin_router(conn_factory))

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.post("/api/login")
    async def login(request: Request):
        if isinstance(auth, NoAuth):
            return {"ok": True}
        ip = request.client.host if request.client else "?"
        if auth.throttled(ip):
            return JSONResponse({"error": "too_many_attempts"}, status_code=429)
        try:
            body = await request.json()
            pw = str(body.get("password", ""))
        except (json.JSONDecodeError, AttributeError):
            pw = ""
        if not auth.check_password(pw):
            auth.note_failure(ip)
            return JSONResponse({"error": "invalid_password"}, status_code=401)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, auth.issue(), max_age=auth.max_age, httponly=True, samesite="strict",
                        secure=auth.secure_cookie, path="/")
        return resp

    @app.post("/api/ingest/instagram")
    def ingest_ig(snap: Snapshot, request: Request):
        """From the Chrome extension: Instagram inbox list snapshot (no message bodies beyond previews)."""
        expected = os.environ.get("INGEST_TOKEN", "")
        if len(expected) < 16:
            return JSONResponse({"error": "ingest_disabled"}, status_code=503)
        got = request.headers.get("X-LW-Ingest-Token", "")
        if not hmac.compare_digest(got.encode(), expected.encode()):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        c = db()
        try:
            routes = active_routes(c)
            new = ingest_instagram(c, snap, routes, settle_sec=instagram_settle_sec)
        finally:
            c.close()
        result = {"ok": True, "new": len(new)}
        if snap.account not in routes:
            result["warning"] = "instagram_account_unmapped"
        return result

    @app.post("/api/logout")
    def logout():
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    @app.get("/api/me")
    def me():
        return {"ok": True}

    @app.get("/api/status")
    def status():
        c = db()
        try:
            return summary(c)
        finally:
            c.close()

    @app.get("/api/clients")
    def clients():
        c = db()
        try:
            return [dict(r) for r in c.execute("SELECT id, name FROM clients WHERE active=1 ORDER BY name")]
        finally:
            c.close()

    @app.get("/api/conversations")
    def conversations(client_id: int | None = None, q: str | None = Query(None, max_length=100)):
        c = db()
        try:
            return dto.list_conversations(c, client_id, q)
        finally:
            c.close()

    @app.get("/api/conversations/{conv_id}/messages")
    def messages(conv_id: int, before: int | None = None, limit: int = Query(50, ge=1, le=200)):
        c = db()
        try:
            if not c.execute("SELECT 1 FROM conversations WHERE id=?", (conv_id,)).fetchone():
                raise HTTPException(404, "not_found")
            return dto.list_messages(c, conv_id, before, limit)
        finally:
            c.close()

    @app.get("/api/events")
    async def events(request: Request):
        q = bus.subscribe()

        async def gen():
            try:
                loop = asyncio.get_running_loop()
                next_status = 0.0
                while True:
                    if bus.is_closed(q) or await request.is_disconnected():
                        break
                    if loop.time() >= next_status:
                        c = db()
                        try:
                            yield {"event": "status", "data": json.dumps(summary(c), ensure_ascii=False)}
                        finally:
                            c.close()
                        next_status = loop.time() + status_interval
                    try:
                        event, data = await asyncio.wait_for(q.get(), timeout=1.0)
                    except TimeoutError:
                        continue
                    yield {"event": event, "data": json.dumps(data, ensure_ascii=False)}
            finally:
                bus.unsubscribe(q)

        return EventSourceResponse(gen(), ping=15)

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        f = (STATIC / path).resolve()
        if path and f.is_file() and STATIC.resolve() in f.parents:
            return FileResponse(f)
        index = STATIC / "index.html"
        if index.exists():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return Response("viewer not built: cd web && npm install && npm run build", media_type="text/plain", status_code=503)

    return app
