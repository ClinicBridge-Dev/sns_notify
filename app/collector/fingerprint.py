"""Fingerprints and window alignment.

A screen read gives us a window of the newest N messages with no stable ids.
We find where the window overlaps what we already stored (sequence alignment on
content keys) and treat only what comes after the overlap as new. Content keys
deliberately ignore the date label ("오늘"/"어제" shift at midnight).

The stored fingerprint chains the previous stored message's fingerprint, so two
identical "네" in the same minute get different fingerprints. Note the unique index
does NOT stop a re-insert of history appended after the current tail (the chain makes
it look new); preventing that is the alignment's job, and anything it cannot place
confidently is returned as ``review`` so it never alerts.
"""
from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field

from .contract import ObservedMessage


def _norm(s: str | None) -> str:
    return unicodedata.normalize("NFC", (s or "").strip())


def body_hash(body: str | None) -> str:
    return hashlib.sha256(_norm(body).encode()).hexdigest()[:16]


def content_key(m: ObservedMessage) -> str:
    if m.external_id:
        return f"ext:{m.external_id}"
    return "|".join([m.direction, m.kind, m.shown_time or "", body_hash(m.body)])


def fingerprint(conversation_id: int, m: ObservedMessage, date_hint: str | None, prev_fp: str | None) -> str:
    raw = "|".join(
        [str(conversation_id), m.direction, date_hint or "", m.shown_time or "", m.kind, body_hash(m.body), prev_fp or ""]
    )
    return hashlib.sha256(raw.encode()).hexdigest()


@dataclass
class Alignment:
    new: list[ObservedMessage]
    review: set[int] = field(default_factory=set)  # indexes into ``new`` that must not alert
    overlap: int = 0
    gap: bool = False  # stored history exists but nothing in the window matched it
    notes: list[str] = field(default_factory=list)

    @property
    def ambiguous(self) -> bool:
        return bool(self.review)


def _dedupe_ext(al: Alignment, stored_ext: set[str] | None) -> Alignment:
    """The same external id can show up twice in one read (scroll overlap): keep the first."""
    seen = set(stored_ext or ())
    new, review = [], set()
    for i, m in enumerate(al.new):
        if m.external_id:
            if m.external_id in seen:
                continue
            seen.add(m.external_id)
        if i in al.review:
            review.add(len(new))
        new.append(m)
    al.new, al.review = new, review
    return al


def _lcs_pairs(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    # Walk from the front but prefer the latest equal match so the stored tail anchors as late as possible.
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j] and dp[i][j] == dp[i + 1][j + 1] + 1 and dp[i][j + 1] < dp[i][j]:
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif dp[i][j + 1] >= dp[i + 1][j]:
            j += 1
        else:
            i += 1
    return pairs


def align_new(
    stored_keys: list[str],
    window: list[ObservedMessage],
    *,
    stored_external_ids: set[str] | None = None,
    stored_is_complete: bool = False,
    window_at_start: bool = False,
) -> Alignment:
    """Return the messages in ``window`` that come after what is already stored.

    ``stored_keys`` are content keys of the stored tail (oldest -> newest).
    Messages that cannot be placed with confidence are returned with their index in ``review``.
    """
    if not window:
        return Alignment([])
    if all(m.external_id for m in window) and stored_external_ids is not None:
        new = [m for m in window if m.external_id not in stored_external_ids]
        return _dedupe_ext(Alignment(new, overlap=len(window) - len(new)), stored_external_ids)
    if not stored_keys:
        return _dedupe_ext(Alignment(list(window)), stored_external_ids)

    wk = [content_key(m) for m in window]
    notes: list[str] = []

    # Both sides start at the conversation's first message: align from the front.
    if stored_is_complete and window_at_start:
        n = len(stored_keys)
        if len(wk) >= n and wk[:n] == stored_keys[:n]:
            return _dedupe_ext(Alignment(list(window[n:]), overlap=n), stored_external_ids)
        notes.append("front_alignment_mismatch")

    # 1) exact: the stored tail appears contiguously in the window
    candidates: list[tuple[int, int]] = []  # (k, j) for full alignments
    for j in range(len(wk)):
        k = 0
        while k <= j and k < len(stored_keys) and wk[j - k] == stored_keys[-1 - k]:
            k += 1
        if k and (k == j + 1 or k == len(stored_keys)):
            candidates.append((k, j))
    if candidates and not notes:
        k, j = max(candidates)
        ties = [c for c in candidates if c[0] == k]
        new = list(window[j + 1 :])
        al = Alignment(new, overlap=k)
        if len(ties) > 1:
            al.notes.append(f"ambiguous_overlap:{len(ties)}")
            al.review = set(range(len(new)))
        return _dedupe_ext(al, stored_external_ids)

    # 2) fuzzy: an edited/deleted/late message broke contiguity. Longest common subsequence
    #    against the recent stored tail; unmatched messages between anchors are stored for review,
    #    trailing ones alert only when the newest stored message itself is anchored.
    tail = stored_keys[-max(2 * len(wk), 10) :]
    pairs = _lcs_pairs(tail, wk)
    if not pairs:
        return _dedupe_ext(
            Alignment(list(window), review=set(range(len(window))), gap=True, notes=notes + ["no_overlap"]),
            stored_external_ids,
        )
    matched = {j for _, j in pairs}
    first_j, (last_i, last_j) = pairs[0][1], pairs[-1]
    anchored = last_i == len(tail) - 1 and len(pairs) >= min(3, len(tail))
    new_idx = [j for j in range(first_j, last_j) if j not in matched] + list(range(last_j + 1, len(wk)))
    new = [window[j] for j in new_idx]
    review = {i for i, j in enumerate(new_idx) if j < last_j or not anchored}
    notes.append("fuzzy_alignment" if anchored else "fuzzy_alignment_unanchored")
    return _dedupe_ext(Alignment(new, review=review, overlap=len(pairs), notes=notes), stored_external_ids)
