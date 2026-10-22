"""Shape of legacy speech reports, without judging their semantic claims."""


def shape_issues(report) -> list[str]:
    if not isinstance(report, dict):
        return ["리포트는 JSON 객체여야 합니다."]
    issues = []
    for key in ("summary", "recommendation"):
        value = report.get(key)
        if not isinstance(value, str) or not value.strip():
            issues.append(f"{key}: 비어 있지 않은 문자열이 필요합니다.")
    comments = report.get("axis_comments")
    if not isinstance(comments, dict):
        issues.append("axis_comments: 축 이름과 설명을 담은 객체가 필요합니다.")
    else:
        for axis, comment in comments.items():
            if not isinstance(axis, str) or not axis.strip():
                issues.append("axis_comments: 축 이름은 비어 있지 않은 문자열이어야 합니다.")
            if not isinstance(comment, str) or not comment.strip():
                issues.append("axis_comments: 축 설명은 비어 있지 않은 문자열이어야 합니다.")
    return issues
