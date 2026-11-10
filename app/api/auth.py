"""Shared-password session auth. Swap ``SessionAuth`` for a Cloudflare Access header check later."""
from __future__ import annotations

import hmac
import time
from collections import defaultdict, deque

from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from starlette.requests import Request

COOKIE = "lw_session"
PUBLIC_API = {"/api/login", "/api/health"}
TOKEN_API_PREFIX = "/api/ingest/"  # authenticated by X-LW-Ingest-Token in the route, not by session


class SessionAuth:
    def __init__(self, password: str, secret: str, max_age_sec: int, secure_cookie: bool = False):
        self._password = password.encode()
        self._signer = TimestampSigner(secret, salt="lw-session")
        self.max_age = max_age_sec
        self.secure_cookie = secure_cookie
        self._fails: dict[str, deque] = defaultdict(deque)

    def check_password(self, attempt: str) -> bool:
        return hmac.compare_digest(attempt.encode(), self._password)

    def throttled(self, ip: str, limit: int = 10, window: float = 300) -> bool:
        q = self._fails[ip]
        now = time.monotonic()
        while q and now - q[0] > window:
            q.popleft()
        return len(q) >= limit

    def note_failure(self, ip: str) -> None:
        self._fails[ip].append(time.monotonic())

    def issue(self) -> str:
        return self._signer.sign(b"staff").decode()

    def is_authenticated(self, request: Request) -> bool:
        token = request.cookies.get(COOKIE)
        if not token:
            return False
        try:
            self._signer.unsign(token, max_age=self.max_age)
            return True
        except (BadSignature, SignatureExpired):
            return False


class NoAuth:
    """Only allowed with a localhost bind (enforced in Config.validate)."""

    max_age = 0
    secure_cookie = False

    def is_authenticated(self, request: Request) -> bool:
        return True
