"""Where Accessibility calls actually happen.

- ``BridgeBackend``: production. 「WhatsApp 수집기」 (the app holding the 손쉬운 사용 grant) performs
  every AX call and serves them to this process over the private socket on fd 0. Selected when the
  app launched us (``LW_AX_BRIDGE=1``). macOS does not extend the app's grant to child processes,
  so this indirection is required, not optional.
- ``DirectBackend``: development only, calls pyobjc in-process (needs the terminal to be granted).
- ``FakeBackend``: tests; serves a recorded snapshot tree.

All three speak the same node format: ``{"path": [int...], "role", "attrs": {...}, "frame": [x,y,w,h]|None,
"children": [...]}``. WhatsApp-specific interpretation lives in ``ax_reader`` rules, never here.
"""
from __future__ import annotations

import copy
import itertools
import json
import os
import socket
import threading
from typing import Any, Callable, Protocol

Node = dict
Path = list[int]
WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp"


class AXCallError(Exception):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(f"{message} ({code})" if code else message)
        self.message = message
        self.code = code


class AXBackend(Protocol):
    def trusted(self) -> bool: ...
    def pid(self) -> int | None: ...
    def snapshot(self, path: Path = (), depth: int = 40, max_nodes: int = 20000,
                 attrs: list[str] | None = None, all_attrs: bool = False) -> Node: ...
    def attr_names(self, path: Path) -> list[str]: ...
    def actions(self, path: Path) -> list[str]: ...
    def perform(self, path: Path, action: str, expect_role: str | None = None) -> None: ...
    def set(self, path: Path, attr: str, value: Any, expect_role: str | None = None) -> None: ...
    def param(self, path: Path, attr: str, rng: tuple[int, int]) -> Any: ...
    def subscribe(self, on_event: Callable[[dict], None]) -> dict: ...


def get_backend() -> AXBackend:
    if os.environ.get("LW_AX_BRIDGE") == "1":
        return BridgeBackend()
    return DirectBackend()


# --------------------------------------------------------------------------------------- bridge
class BridgeBackend:
    def __init__(self, sock: socket.socket | None = None, timeout: float = 30):
        self.sock = sock or socket.socket(fileno=os.dup(0))
        self.timeout = timeout
        self._ids = itertools.count(1)
        self._pending: dict[int, list] = {}  # id -> [Event, response]
        self._lock = threading.Lock()
        self._wlock = threading.Lock()
        self._listeners: list[Callable[[dict], None]] = []
        self._closed = False
        self._reader = threading.Thread(target=self._read_loop, name="ax-bridge-reader", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        f = self.sock.makefile("rb")
        try:
            for line in f:
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "event" in msg:
                    for cb in list(self._listeners):
                        try:
                            cb(msg)
                        except Exception:
                            pass
                    continue
                with self._lock:
                    slot = self._pending.get(msg.get("id"))
                if slot:
                    slot[1] = msg
                    slot[0].set()
        finally:
            self._closed = True
            with self._lock:
                for slot in self._pending.values():
                    slot[0].set()

    def call(self, op: str, **kw) -> Any:
        if self._closed:
            raise AXCallError("bridge_closed")
        rid = next(self._ids)
        slot = [threading.Event(), None]
        with self._lock:
            self._pending[rid] = slot
        try:
            data = json.dumps({"id": rid, "op": op, **kw}).encode() + b"\n"
            with self._wlock:
                try:
                    self.sock.sendall(data)
                except OSError as e:
                    raise AXCallError("bridge_closed") from e
            if not slot[0].wait(self.timeout):
                raise AXCallError("bridge_timeout")
            resp = slot[1]
            if resp is None:
                raise AXCallError("bridge_closed")
            if not resp.get("ok"):
                raise AXCallError(resp.get("error", "error"), resp.get("code"))
            return resp.get("result")
        finally:
            with self._lock:
                self._pending.pop(rid, None)

    def trusted(self) -> bool:
        return bool(self.call("trusted"))

    def pid(self) -> int | None:
        return self.call("pid")

    def snapshot(self, path=(), depth=40, max_nodes=20000, attrs=None, all_attrs=False) -> Node:
        kw = {"path": list(path), "depth": depth, "max_nodes": max_nodes, "all_attrs": all_attrs}
        if attrs:
            kw["attrs"] = attrs
        return self.call("snapshot", **kw)

    def attr_names(self, path) -> list[str]:
        return self.call("attr_names", path=list(path))

    def actions(self, path) -> list[str]:
        return self.call("actions", path=list(path))

    def perform(self, path, action, expect_role=None) -> None:
        self.call("perform", path=list(path), action=action, **({"expect_role": expect_role} if expect_role else {}))

    def set(self, path, attr, value, expect_role=None) -> None:
        self.call("set", path=list(path), attr=attr, value=value, **({"expect_role": expect_role} if expect_role else {}))

    def param(self, path, attr, rng) -> Any:
        return self.call("param", path=list(path), attr=attr, range=list(rng))

    def subscribe(self, on_event) -> dict:
        self._listeners.append(on_event)
        return self.call("subscribe")


# --------------------------------------------------------------------------------------- direct
class DirectBackend:
    """pyobjc in this process. Only works when *this* process (e.g. the terminal) is trusted."""

    def __init__(self, bundle_id: str = WHATSAPP_BUNDLE_ID):
        self.bundle_id = bundle_id

    def trusted(self) -> bool:
        from . import ax

        return ax.is_trusted(prompt=False)

    def pid(self) -> int | None:
        from . import ax

        return ax.find_pid(self.bundle_id)

    def _el(self, path):
        from . import ax

        if not self.trusted():
            raise AXCallError("not_trusted", -25211)
        pid = self.pid()
        if not pid:
            raise AXCallError("target_not_running")
        el = ax.app_element(pid)
        for depth, i in enumerate(path):
            kids = ax.children(el)
            if not 0 <= i < len(kids):
                raise AXCallError(f"stale_path_at_{depth}")
            el = kids[i]
        return el

    def snapshot(self, path=(), depth=40, max_nodes=20000, attrs=None, all_attrs=False) -> Node:
        from . import ax

        return ax.snapshot_dict(self._el(path), list(path), depth, max_nodes, attrs, all_attrs)

    def attr_names(self, path):
        from . import ax

        return ax.attr_names(self._el(path))

    def actions(self, path):
        from . import ax

        return ax.action_names(self._el(path))

    def _check_role(self, el, expect_role):
        from . import ax

        if expect_role and ax.attr(el, "AXRole") != expect_role:
            raise AXCallError("role_mismatch")

    def perform(self, path, action, expect_role=None) -> None:
        from . import ax

        el = self._el(path)
        self._check_role(el, expect_role)
        if not ax.perform(el, action):
            raise AXCallError("perform_failed")

    def set(self, path, attr, value, expect_role=None) -> None:
        from . import ax

        el = self._el(path)
        self._check_role(el, expect_role)
        if not ax.set_attr(el, attr, value):
            raise AXCallError("set_failed")

    def param(self, path, attr, rng):
        raise AXCallError("param_not_supported_in_direct_backend")

    def subscribe(self, on_event) -> dict:
        from . import ax

        pid = self.pid()
        if not pid or not self.trusted():
            raise AXCallError("not_available")

        def run():
            ax.observe(pid, lambda name, el: on_event({"event": name, "role": ax.attr(el, "AXRole")}))

        threading.Thread(target=run, name="ax-direct-observer", daemon=True).start()
        return {"registrations": {}}


# --------------------------------------------------------------------------------------- fake
class FakeBackend:
    def __init__(self, tree: Node, *, trusted: bool = True, pid: int | None = 4242):
        self.tree = tree
        self._trusted = trusted
        self._pid = pid
        self.performed: list[tuple] = []

    def trusted(self) -> bool:
        return self._trusted

    def pid(self) -> int | None:
        return self._pid

    def _node(self, path) -> Node:
        n = self.tree
        for depth, i in enumerate(path):
            kids = n.get("children") or []
            if not 0 <= i < len(kids):
                raise AXCallError(f"stale_path_at_{depth}")
            n = kids[i]
        return n

    def snapshot(self, path=(), depth=40, max_nodes=20000, attrs=None, all_attrs=False) -> Node:
        def cut(n, d):
            c = {k: v for k, v in n.items() if k != "children"}
            c["children"] = [cut(ch, d - 1) for ch in n.get("children", [])] if d > 0 else []
            return c

        return cut(copy.deepcopy(self._node(path)), depth)

    def attr_names(self, path):
        return list(self._node(path).get("attrs", {}))

    def actions(self, path):
        return list(self._node(path).get("actions", []))

    def perform(self, path, action, expect_role=None) -> None:
        n = self._node(path)
        if expect_role and n.get("role") != expect_role:
            raise AXCallError("role_mismatch")
        self.performed.append(("perform", list(path), action))

    def set(self, path, attr, value, expect_role=None) -> None:
        self._node(path).setdefault("attrs", {})[attr] = value
        self.performed.append(("set", list(path), attr, value))

    def param(self, path, attr, rng):
        return None

    def subscribe(self, on_event) -> dict:
        return {"registrations": {}}


def walk(node: Node):
    """Depth-first over a snapshot tree."""
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.get("children") or []))
