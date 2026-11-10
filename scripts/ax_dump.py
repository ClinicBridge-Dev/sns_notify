#!/usr/bin/env python3
"""Phase 0 tool: inspect WhatsApp's Accessibility tree. Read-only — never clicks, types, or launches anything.

Normally run by the 「WhatsApp 수집기」 app (menu 「화면 구조 기록」, or wacollector:// on a --dev
install), so it uses the app's 손쉬운 사용 permission through the app. Run from a terminal it falls
back to the terminal's own permission.

  check                       permission / running / screen lock + a real probe
  dump [--depth N]            full tree with all attributes -> ax_dumps/tree-*.json (owner-only)
  find TEXT                   print paths of nodes whose text contains TEXT
  observe --seconds 120       which AX notifications WhatsApp sends -> ax_dumps/events-*.jsonl
  read [--conv NAME]          what the collector's reader would store -> ax_dumps/read-*.json

Dumps contain real customer messages: they stay in ax_dumps/ (git-ignored, owner-only). Delete when done.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.collector.ax_backend import AXCallError, get_backend, walk  # noqa: E402
from app.collector.ax_reader import AXReader, screen_locked  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "ax_dumps"


def _private_file(name: str) -> Path:
    OUT.mkdir(exist_ok=True)
    os.chmod(OUT, 0o700)
    p = OUT / name
    p.touch(mode=0o600)
    os.chmod(p, 0o600)
    return p


def _ready(backend) -> int | None:
    via = "앱(WhatsApp 수집기) 경유" if os.environ.get("LW_AX_BRIDGE") == "1" else f"이 프로세스 직접 ({sys.executable})"
    try:
        trusted, pid = backend.trusted(), backend.pid()
    except AXCallError as e:
        print(f"bridge error: {e}")
        return None
    print(f"accessibility via      : {via}")
    print(f"accessibility trusted  : {trusted}")
    print(f"whatsapp pid           : {pid}")
    print(f"screen locked          : {screen_locked()}")
    if not trusted:
        print("\n→ 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용 > 'WhatsApp 수집기'를 켜 주세요.")
        return None
    if not pid:
        print("\n→ WhatsApp을 열어 주세요 (이 도구는 앱을 실행하지 않습니다).")
        return None
    return pid


def cmd_check(a, b) -> int:
    ok = _ready(b)
    if ok:
        try:
            root = b.snapshot([], depth=1)
            wins = [c for c in root["children"] if c.get("role") == "AXWindow"]
            print(f"probe                  : {len(root['children'])} top-level element(s), {len(wins)} window(s)")
        except AXCallError as e:
            print(f"probe                  : FAILED {e}")
            return 1
    return 0 if ok else 1


def _summary(root) -> None:
    roles: Counter = Counter()
    texty = 0
    for n in walk(root):
        roles[n.get("role")] += 1
        if any(k in n.get("attrs", {}) for k in ("AXValue", "AXDescription", "AXTitle", "AXLabel")):
            texty += 1
    print(f"{sum(roles.values())} nodes, {texty} with text")
    for role, n in roles.most_common(15):
        print(f"  {n:6d}  {role}")


def cmd_dump(a, b) -> int:
    if not _ready(b):
        return 1
    t0 = time.monotonic()
    root = b.snapshot([], depth=a.depth, max_nodes=a.max_nodes, all_attrs=True)
    took = time.monotonic() - t0
    p = _private_file(f"tree-{datetime.now():%Y%m%d-%H%M%S}.json")
    p.write_text(json.dumps(root, ensure_ascii=False, indent=1))
    print(f"\nwrote {p} ({took:.2f}s)")
    _summary(root)
    return 0


def cmd_find(a, b) -> int:
    if not _ready(b):
        return 1
    root = b.snapshot([], depth=a.depth, max_nodes=a.max_nodes)
    hits = 0
    for n in walk(root):
        for k, v in n.get("attrs", {}).items():
            if isinstance(v, str) and a.text in v:
                hits += 1
                path = ".".join(map(str, n["path"]))
                print(f"{path:30s} {n.get('role') or '':18s} {k}={v[:120]!r} frame={n.get('frame')}")
                break
    print(f"\n{hits} node(s)")
    return 0


def cmd_observe(a, b) -> int:
    if not _ready(b):
        return 1
    p = _private_file(f"events-{datetime.now():%Y%m%d-%H%M%S}.jsonl")
    f = p.open("a")
    t0 = time.monotonic()

    def on_event(ev):
        ev = {"t": round(time.monotonic() - t0, 3), **ev}
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        f.flush()
        print(f"{ev['t']:8.3f}  {ev.get('event', ''):28s} {ev.get('role') or ''}")

    regs = b.subscribe(on_event)
    print("registration results (0 = supported):")
    for n, err in (regs.get("registrations") or {}).items():
        print(f"  {n:28s} {err}")
    time.sleep(a.seconds)
    print(f"events -> {p}")
    return 0


def cmd_read(a, b) -> int:
    reader = AXReader(b)
    st = reader.status()
    print(f"reader status: {st.state} ({st.detail})")
    out = {"status": asdict(st), "conversations": [], "messages": None}
    if st.state == "ok":
        convs = reader.list_conversations()
        out["conversations"] = [asdict(c) for c in convs]
        print(f"{len(convs)} conversation(s)")
        for c in convs[:40]:
            print(f"  {'[group] ' if c.is_group else ''}{c.display_name}  key={c.external_key}  cursor={c.list_cursor}")
        if a.conv:
            target = next((c for c in convs if c.display_name == a.conv), None)
        else:  # default: the chat already open on screen, so the test never clicks anything
            target = getattr(reader.rules, "current_conversation", lambda _b: None)(b)
        if target:
            win = reader.read_messages(target, a.limit)
            out["messages"] = {"conversation": target.display_name, "at_start": win.at_start,
                               "items": [asdict(m) for m in win.messages]}
            print(f"\n--- {target.display_name} ({len(win.messages)} messages, at_start={win.at_start}) ---")
            for m in win.messages:
                flags = f" {list(m.flags)}" if m.flags else ""
                print(f"  [{m.shown_date_hint or '?'} {m.shown_time or '?'}] {m.direction:8s} {m.kind:10s} {m.body!r}{flags}")
    p = _private_file(f"read-{datetime.now():%Y%m%d-%H%M%S}.json")
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"\nwrote {p}")
    return 0 if st.state == "ok" else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    for name in ("dump", "find"):
        s = sub.add_parser(name)
        if name == "find":
            s.add_argument("text")
        s.add_argument("--depth", type=int, default=60)
        s.add_argument("--max-nodes", type=int, default=50000)
    o = sub.add_parser("observe")
    o.add_argument("--seconds", type=float, default=120)
    r = sub.add_parser("read")
    r.add_argument("--conv")
    r.add_argument("--limit", type=int, default=30)
    a = ap.parse_args()
    b = get_backend()
    cmds = {"check": cmd_check, "dump": cmd_dump, "find": cmd_find, "observe": cmd_observe, "read": cmd_read}
    return cmds[a.cmd](a, b)


if __name__ == "__main__":
    raise SystemExit(main())
