"""Types shared by generated interpretation fields and their HTTP projection.

Optional fields may remain absent or empty. This checks shape, not completeness
of information, clinical meaning, or whether an axis belongs to the input.
"""


def shape_issues(report) -> list[str]:
    if not isinstance(report, dict):
        return ['해석은 JSON 객체여야 합니다.']
    issues = []
    if not isinstance(report.get('summary'), str) or not report['summary'].strip():
        issues.append('summary: 비어 있지 않은 문자열이 필요합니다.')
    for field in ('caveats', 'recommendation'):
        if field in report and not isinstance(report[field], str):
            issues.append(f'{field}: 문자열이 필요합니다.')
    if 'axis_comments' in report:
        comments = report['axis_comments']
        if not isinstance(comments, dict):
            issues.append('axis_comments: 축 이름과 설명을 담은 객체가 필요합니다.')
        elif any(not isinstance(k, str) or not isinstance(v, str) for k,v in comments.items()):
            issues.append('axis_comments: 축 이름과 설명은 문자열이어야 합니다.')
    return issues
