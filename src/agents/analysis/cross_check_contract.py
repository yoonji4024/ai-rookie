"""Structural consistency of verifier replies, not semantic truth of a report."""
from collections.abc import Mapping


REPORT_FIELDS = frozenset(("grounded", "no_diagnosis", "no_invention", "issues"))
MATCH_FIELDS = frozenset(("wrong_matches", "missed_scenes"))


def _reply(value) -> bool:
    return (isinstance(value, Mapping)
            and value.get("verdict") in ("pass", "fail")
            and not value.get("error") and not value.get("_error"))


def valid_report_check(value) -> bool:
    if not _reply(value):
        return False
    flags = [value.get(key) for key in ("grounded", "no_diagnosis", "no_invention")]
    issues = value.get("issues")
    if not all(type(flag) is bool for flag in flags):
        return False
    if not isinstance(issues, list) or not all(isinstance(x, str) and x.strip() for x in issues):
        return False
    consistent_pass = all(flags) and not issues
    return (value["verdict"] == "pass") == consistent_pass


def valid_matching_check(value, allowed_ids=None) -> bool:
    if not _reply(value):
        return False
    for key in MATCH_FIELDS:
        entries = value.get(key)
        if not isinstance(entries, list):
            return False
        seen = set()
        for item in entries:
            if not isinstance(item, Mapping):
                return False
            sid, reason = item.get("scene_id"), item.get("reason")
            if not isinstance(sid, str) or not sid.strip() or sid in seen:
                return False
            if allowed_ids is not None and sid not in allowed_ids:
                return False
            if not isinstance(reason, str) or not reason.strip():
                return False
            seen.add(sid)
    consistent_pass = not value["wrong_matches"] and not value["missed_scenes"]
    return (value["verdict"] == "pass") == consistent_pass


def aggregate_checks(checks) -> dict:
    if not isinstance(checks, Mapping):
        return {"all_pass": False, "failed": [], "unknown": ["invalid_checks"], "detail": checks}
    failed, unknown = [], []
    for name, value in checks.items():
        if isinstance(value, Mapping) and value.get("verdict") == "fail":
            # Preserve explicit rejection, including deterministic rule rejection.
            failed.append(name)
            continue
        if not isinstance(value, Mapping) or value.get("verdict") != "pass":
            unknown.append(name)
            continue
        report = bool(REPORT_FIELDS.intersection(value))
        matching = bool(MATCH_FIELDS.intersection(value))
        if (not (report or matching)
                or (report and not valid_report_check(value))
                or (matching and not valid_matching_check(value))):
            unknown.append(name)
    return {"all_pass": bool(checks) and not failed and not unknown,
            "failed": failed, "unknown": unknown, "detail": checks}
