"""Slack message text. Customer text is escaped so it can never mention, link, or ping anyone."""
from __future__ import annotations

from typing import Mapping

PLACEHOLDER = {"attachment": "첨부", "voice": "음성 메시지", "sticker": "스티커", "other": "기타"}
SECTION_MAX = 1500


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _clip(text: str, mid: int) -> str:
    if len(text) <= SECTION_MAX:
        return text
    return text[:SECTION_MAX] + f"… (잘림: 전체 {len(text)}자, 뷰어에서 msg #{mid} 확인)"


def body_text(msg: Mapping) -> str:
    kind, body = msg["kind"], (msg["body"] or "").strip()
    if kind in ("text", "caption"):
        if kind == "caption" and msg.get("attachment_label"):
            return f"[{msg['attachment_label']} 첨부] {body}".strip()
        return body
    label = msg.get("attachment_label") or PLACEHOLDER.get(kind, "첨부")
    head = f"[{label} 첨부]" if kind == "attachment" else f"[{label}]"
    return f"{head} {body}".strip()


def render(msg: Mapping, conv_name: str, client_name: str, tr: Mapping | None) -> tuple[str, bool]:
    """Return (text, translation_included). included=False means a later chat.update is wanted."""
    mid = msg["id"]
    when = " ".join(x for x in (msg.get("shown_date_hint"), msg.get("shown_time")) if x)
    head = f"*[{escape(client_name)}] {escape(conv_name)}*" + (f" · {when}" if when else "")
    if msg.get("collect_mode") == "catchup":
        head += " · `지연 수집`"
    original = _clip(escape(body_text(msg)), mid)
    lines = [head, original]
    status = (tr or {}).get("status")
    included = True
    if status == "done" and (tr or {}).get("ko_text"):
        lines += ["— 한국어 —", _clip(escape(tr["ko_text"]), mid)]
    elif status in ("pending", "retry", None):
        lines.append("_번역 중… 완료되면 이 메시지가 갱신됩니다_")
        included = False
    elif status == "failed":
        lines.append("_번역 실패: 원문만 표시_")
    lines.append(f"`msg #{mid}`")
    return "\n".join(lines), included
