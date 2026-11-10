"""Thin pyobjc wrappers over the macOS Accessibility API, used by ``DirectBackend`` (development only).

In production the 「WhatsApp 수집기」 app performs AX calls (mac/WhatsAppCollector/Bridge.swift);
these in-process calls only work when the calling process itself (e.g. a terminal) is trusted.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterator

WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp"

TEXT_ATTRS = ("AXRole", "AXSubrole", "AXRoleDescription", "AXIdentifier", "AXTitle", "AXDescription",
              "AXValue", "AXHelp", "AXLabel", "AXPlaceholderValue", "AXSelected", "AXEnabled", "AXFocused")
GEOM_ATTRS = ("AXPosition", "AXSize")


def is_trusted(prompt: bool = False) -> bool:
    from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

    return bool(AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: bool(prompt)}))


def find_pid(bundle_id: str = WHATSAPP_BUNDLE_ID) -> int | None:
    from AppKit import NSRunningApplication

    apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(bundle_id)
    return int(apps[0].processIdentifier()) if apps and len(apps) else None


def screen_locked() -> bool | None:
    """True when the login window / screen lock is up. None if it can't be determined."""
    try:
        from Quartz import CGSessionCopyCurrentDictionary

        d = CGSessionCopyCurrentDictionary() or {}
        return bool(d.get("CGSSessionScreenIsLocked", False))
    except Exception:
        return None


def app_element(pid: int, timeout_sec: float = 5.0):
    from ApplicationServices import AXUIElementCreateApplication, AXUIElementSetMessagingTimeout

    el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, timeout_sec)  # an unresponsive WhatsApp must not hang a pass forever
    return el


def attr(el, name: str) -> Any:
    from ApplicationServices import AXUIElementCopyAttributeValue

    err, value = AXUIElementCopyAttributeValue(el, name, None)
    return value if err == 0 else None


def attr_names(el) -> list[str]:
    from ApplicationServices import AXUIElementCopyAttributeNames

    err, names = AXUIElementCopyAttributeNames(el, None)
    return list(names) if err == 0 and names else []


def action_names(el) -> list[str]:
    from ApplicationServices import AXUIElementCopyActionNames

    err, names = AXUIElementCopyActionNames(el, None)
    return list(names) if err == 0 and names else []


def perform(el, action: str) -> bool:
    from ApplicationServices import AXUIElementPerformAction

    return AXUIElementPerformAction(el, action) == 0


def set_attr(el, name: str, value) -> bool:
    from ApplicationServices import AXUIElementSetAttributeValue

    return AXUIElementSetAttributeValue(el, name, value) == 0


def children(el) -> list:
    return list(attr(el, "AXChildren") or [])


def geometry(el) -> tuple[float, float, float, float] | None:
    from ApplicationServices import AXValueGetValue, kAXValueCGPointType, kAXValueCGSizeType

    pos, size = attr(el, "AXPosition"), attr(el, "AXSize")
    if pos is None or size is None:
        return None
    ok1, p = AXValueGetValue(pos, kAXValueCGPointType, None)
    ok2, s = AXValueGetValue(size, kAXValueCGSizeType, None)
    if not (ok1 and ok2):
        return None
    return (float(p.x), float(p.y), float(s.width), float(s.height))


def _plain(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    try:
        return str(v)
    except Exception:
        return repr(v)


@dataclass
class Node:
    path: str
    role: str | None
    attrs: dict
    frame: tuple | None
    children: list["Node"]

    def to_dict(self) -> dict:
        return {"path": self.path, "role": self.role, "attrs": self.attrs, "frame": self.frame,
                "children": [c.to_dict() for c in self.children]}


def snapshot(el, max_depth: int = 40, max_nodes: int = 20000, path: str = "0", _count: list | None = None) -> Node:
    count = _count if _count is not None else [0]
    count[0] += 1
    attrs = {}
    for a in TEXT_ATTRS:
        v = attr(el, a)
        if v not in (None, ""):
            attrs[a] = _plain(v)
    node = Node(path, attrs.get("AXRole"), attrs, geometry(el), [])
    if max_depth > 0 and count[0] < max_nodes:
        for i, ch in enumerate(children(el)):
            if count[0] >= max_nodes:
                break
            node.children.append(snapshot(ch, max_depth - 1, max_nodes, f"{path}.{i}", count))
    return node


def snapshot_dict(el, path: list[int], depth: int = 40, max_nodes: int = 20000,
                  attrs: list[str] | None = None, all_attrs: bool = False, _budget: list | None = None) -> dict:
    """Same node shape the app's bridge returns (see ax_backend)."""
    budget = _budget if _budget is not None else [max_nodes]
    budget[0] -= 1
    names = list(attrs or TEXT_ATTRS)
    if all_attrs:
        skip = {"AXChildren", "AXParent", "AXWindow", "AXTopLevelUIElement", "AXChildrenInNavigationOrder", "AXVisibleChildren"}
        names = [n for n in attr_names(el) if n not in skip]
    values = {}
    for a in names:
        v = attr(el, a)
        if v not in (None, ""):
            values[a] = _plain(v)
    node = {"path": path, "role": values.get("AXRole"), "attrs": values, "frame": geometry(el), "children": []}
    if depth > 0:
        for i, ch in enumerate(children(el)):
            if budget[0] <= 0:
                node["truncated"] = True
                break
            node["children"].append(snapshot_dict(ch, path + [i], depth - 1, max_nodes, attrs, all_attrs, budget))
    return node


def walk(el, max_depth: int = 40) -> Iterator[tuple[int, Any]]:
    stack = [(0, el)]
    while stack:
        d, e = stack.pop()
        yield d, e
        if d < max_depth:
            for ch in reversed(children(e)):
                stack.append((d + 1, ch))


DEFAULT_NOTIFICATIONS = (
    "AXValueChanged", "AXUIElementCreated", "AXUIElementDestroyed", "AXLayoutChanged", "AXTitleChanged",
    "AXFocusedUIElementChanged", "AXSelectedChildrenChanged", "AXRowCountChanged", "AXSelectedRowsChanged",
    "AXWindowCreated", "AXAnnouncementRequested",
)


def observe(pid: int, on_event: Callable[[str, Any], None], notifications=DEFAULT_NOTIFICATIONS,
            seconds: float | None = None, stop: Callable[[], bool] | None = None) -> dict[str, int]:
    """Run a CFRunLoop in the current thread delivering AX notifications for ``pid``.

    Returns {notification: error_code} for registration so Phase 0 can see which ones the app supports.
    """
    from ApplicationServices import AXObserverAddNotification, AXObserverCreate, AXObserverGetRunLoopSource
    from CoreFoundation import CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRunInMode, kCFRunLoopDefaultMode

    def cb(observer, element, notification, refcon):
        try:
            on_event(str(notification), element)
        except Exception:  # never let an exception unwind into CoreFoundation
            pass

    err, obs = AXObserverCreate(pid, cb, None)
    if err != 0:
        raise RuntimeError(f"AXObserverCreate failed: {err}")
    app = app_element(pid)
    reg = {n: AXObserverAddNotification(obs, app, n, None) for n in notifications}
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), kCFRunLoopDefaultMode)
    end = time.monotonic() + seconds if seconds else None
    while (end is None or time.monotonic() < end) and not (stop and stop()):
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, False)
    return reg
