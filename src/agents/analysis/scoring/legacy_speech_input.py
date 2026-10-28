"""Prerequisites for the legacy full verifier, not partial-score computation."""
import math


def _finite_number(value) -> bool:
    if type(value) not in (int, float, str):
        return False
    try:
        return math.isfinite(float(value))
    except (ValueError, TypeError, OverflowError):
        return False


def input_issues(score, *, require_prompt: bool = False) -> list[str]:
    if not isinstance(score, dict):
        return ["별도 전체 검증에 필요한 점수 객체가 없습니다."]
    issues = []

    def number(mapping, key, path):
        if not _finite_number(mapping.get(key)):
            issues.append(f"별도 전체 검증에 필요한 유한한 수치가 없습니다: {path}")

    def text(mapping, key, path):
        value = mapping.get(key)
        if not isinstance(value, str) or not value.strip():
            issues.append(f"생성 요청에 필요한 문자열이 없습니다: {path}")

    number(score, "total_score", "total_score")
    if require_prompt:
        text(score, "grade", "grade")
        weakest = score.get("weakest", [])
        if not isinstance(weakest, list) or any(not isinstance(v, str) or not v.strip() for v in weakest):
            issues.append("생성 요청의 weakest는 비어 있지 않은 문자열의 목록이어야 합니다.")
    axes = score.get("axes")
    if not isinstance(axes, dict):
        issues.append("별도 전체 검증에 필요한 axes 객체가 없습니다.")
        return issues
    for axis, data in axes.items():
        if not isinstance(data, dict):
            issues.append(f"별도 전체 검증에 필요한 축 객체가 없습니다: {axis}")
            continue
        number(data, "score", f"axes.{axis}.score")
        features = data.get("features")
        if not isinstance(features, dict):
            issues.append(f"별도 전체 검증에 필요한 features 객체가 없습니다: {axis}")
            continue
        for feature, values in features.items():
            prefix = f"axes.{axis}.features.{feature}"
            if not isinstance(values, dict):
                issues.append(f"별도 전체 검증에 필요한 측정값 객체가 없습니다: {prefix}")
                continue
            for key in ("value", "hc_mean", "z"):
                number(values, key, f"{prefix}.{key}")
            if require_prompt:
                text(values, "direction", f"{prefix}.direction")
    return issues
