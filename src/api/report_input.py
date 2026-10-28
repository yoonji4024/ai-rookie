"""Small input contract shared by report analysis and its failure fallback."""


def usable_answer_text(value: object) -> str:
    """Preserve usable strings verbatim; never turn objects into speech text."""
    return value if isinstance(value, str) and value.strip() else ''


def normalize_answer_texts(items: list[dict]) -> list[dict]:
    """Copy answer objects so original supplied values are not mutated."""
    return [{**item, 'userAnswer': usable_answer_text(item.get('userAnswer'))} for item in items]
