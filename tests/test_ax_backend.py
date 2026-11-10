"""Python half of the app<->collector AX bridge, plus the fake backend used for rule tests."""
import json
import socket
import threading
import time

import pytest

from app.collector.ax_backend import AXCallError, BridgeBackend, FakeBackend
from app.collector.ax_reader import AXReader

TREE = {
    "path": [], "role": "AXApplication", "attrs": {"AXRole": "AXApplication", "AXTitle": "WhatsApp"}, "frame": None,
    "children": [
        {"path": [0], "role": "AXWindow", "attrs": {"AXRole": "AXWindow"}, "frame": [0, 0, 800, 600], "children": [
            {"path": [0, 0], "role": "AXStaticText", "attrs": {"AXRole": "AXStaticText", "AXValue": "네"},
             "frame": [10, 10, 20, 10], "children": []},
        ]},
    ],
}


def test_fake_backend_subtree_and_depth():
    b = FakeBackend(TREE)
    assert b.snapshot([0, 0])["attrs"]["AXValue"] == "네"
    shallow = b.snapshot([], depth=1)
    assert shallow["children"][0]["children"] == []
    with pytest.raises(AXCallError):
        b.snapshot([3])


def test_reader_status_paths():
    assert AXReader(FakeBackend(TREE, trusted=False)).status().detail == "ax_not_trusted"
    assert AXReader(FakeBackend(TREE, pid=None)).status().state == "disconnected"
    from app.collector.ax_reader import PendingRules

    assert AXReader(FakeBackend(TREE), PendingRules()).status().detail == "ax_rules_pending_phase0"


class FakeApp(threading.Thread):
    """Plays the Swift side of the protocol on one end of a socketpair."""

    def __init__(self, sock):
        super().__init__(daemon=True)
        self.sock = sock
        self.f = sock.makefile("rwb")

    def send(self, obj):
        self.f.write(json.dumps(obj).encode() + b"\n")
        self.f.flush()

    def run(self):
        for line in self.f:
            req = json.loads(line)
            op = req["op"]
            if op == "trusted":
                self.send({"id": req["id"], "ok": True, "result": True})
            elif op == "snapshot":
                self.send({"event": "AXValueChanged", "role": "AXStaticText", "t": 1.0})  # interleaved event
                self.send({"id": req["id"], "ok": True, "result": TREE})
            elif op == "subscribe":
                self.send({"id": req["id"], "ok": True, "result": {"registrations": {"AXValueChanged": 0}}})
            else:
                self.send({"id": req["id"], "ok": False, "error": "perform_failed", "code": -25205})


def test_bridge_backend_roundtrip_events_and_errors():
    a, b = socket.socketpair()
    FakeApp(a).start()
    be = BridgeBackend(sock=b)
    assert be.trusted() is True
    events = []
    regs = be.subscribe(events.append)
    assert regs["registrations"] == {"AXValueChanged": 0}
    assert be.snapshot([])["role"] == "AXApplication"
    deadline = time.time() + 2
    while not events and time.time() < deadline:
        time.sleep(0.01)
    assert events and events[0]["event"] == "AXValueChanged"
    with pytest.raises(AXCallError) as e:
        be.perform([0], "AXPress")
    assert e.value.code == -25205


def test_bridge_backend_fails_fast_when_app_closes():
    a, b = socket.socketpair()
    be = BridgeBackend(sock=b, timeout=1)
    a.close()
    with pytest.raises(AXCallError):
        be.trusted()
