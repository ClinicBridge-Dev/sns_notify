"""Cheap local language gate: Korean never goes to the API."""
from __future__ import annotations

import re

_URL = re.compile(r"https?://\S+|www\.\S+|\S+@\S+\.\S+")


def _is_hangul(ch: str) -> bool:
    o = ord(ch)
    return 0xAC00 <= o <= 0xD7A3 or 0x1100 <= o <= 0x11FF or 0x3130 <= o <= 0x318F


def detect(text: str | None, ko_ratio: float = 0.8) -> tuple[str | None, bool]:
    """Return (lang, needs_api). lang is 'ko', 'unknown', or None when the API should decide."""
    letters = [ch for ch in _URL.sub(" ", text or "") if ch.isalpha()]
    if not letters:
        return "unknown", False  # digits / emoji / punctuation only: nothing to translate
    hangul = sum(1 for ch in letters if _is_hangul(ch))
    if hangul / len(letters) >= ko_ratio:
        return "ko", False
    return None, True
