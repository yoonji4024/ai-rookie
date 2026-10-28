"""Mechanical output integrity; deliberately not a PII detection guarantee."""
from __future__ import annotations

import re


def is_masking_only(original: str, candidate: object) -> bool:
    """Accept an exact copy or monotonic replacements by four configured tags.

    A replacement consumes at least one source character, starts/ends with a
    non-whitespace character and cannot consume a square bracket. Existing
    bracketed markers therefore survive unchanged/in order.
    Other output characters must be copied exactly, including whitespace.

    This proves only that such an alignment exists. It does not establish that
    a replaced span is PII, that a tag is semantically correct, or that all PII
    was removed. Whole-span overmasking and unchanged residual PII can pass.
    """
    if not isinstance(candidate, str) or not candidate.strip():
        return False
    if candidate == original:
        return True
    tags = {'[이름]', '[기관]', '[생년월일]', '[연락처]'}
    pieces = re.split(r'(\[[^\[\]\r\n]*\])', candidate)
    n = len(original)
    # For each offset, the first bracket at/after it (exclusive consume limit).
    stop = [n] * (n + 1)
    for pos in range(n - 1, -1, -1):
        stop[pos] = pos if original[pos] in '[]' else stop[pos + 1]
    reachable = {0}
    for piece in pieces:
        if not piece:
            continue
        following = {p + len(piece) for p in reachable if original.startswith(piece, p)}
        if piece in tags:
            # Union of possible nonempty consumed spans. Difference intervals
            # avoid quadratic expansion when many alignments are ambiguous.
            changes = [0] * (n + 2)
            for pos in reachable:
                if pos < stop[pos] and not original[pos].isspace():
                    changes[pos + 1] += 1
                    changes[stop[pos] + 1] -= 1
            active = 0
            for pos in range(n + 1):
                active += changes[pos]
                if active and pos > 0 and not original[pos - 1].isspace():
                    following.add(pos)
        reachable = following
        if not reachable:
            return False
    return n in reachable
