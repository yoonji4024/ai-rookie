"""Fallbacks for the demo's fame question, limited to an asserted anchor.

These are fixed reactions, not a semantic validator for generated text. The
caller supplies the assertion after self-correction and the established mode.
"""

_NEUTRAL = (
    "그 시절 이야기를 조금 더 들어봐요. 저는 뒷이야기도 궁금해요.",
    "옛이야기를 들으니 저도 귀를 기울이게 돼요. 편하게 이어서 들어봐요.",
    "저는 그 시절 이야기가 더 궁금해지네요. 조금 더 이어서 들어봐요.",
)

_ASSERTED = {
    "유명": (
        "유명해졌다는 이야기를 들으니, 그 시절이 더 궁금해지네요.",
        "유명했던 때의 이야기라니, 저는 조금 더 들어보고 싶네요.",
        "유명해진 분의 옛이야기라니, 저는 더 귀를 기울이게 되네요.",
    ),
    "인기": (
        "인기가 있었다는 이야기를 들으니, 그 시절이 더 궁금해지네요.",
        "인기 있던 때의 이야기라니, 저는 조금 더 들어보고 싶네요.",
        "그때 인기가 있었다니, 옛이야기가 조금 더 특별하게 들려요.",
    ),
    "대상": (
        "대상을 받았다는 이야기를 들으니, 그 시절이 더 궁금해지네요.",
        "대상을 받은 이야기라니, 저는 조금 더 들어보고 싶네요.",
        "대상을 받은 분의 옛이야기라니, 저는 더 귀를 기울이게 되네요.",
    ),
}


def x1_fallback_candidates(mode: str, anchor: str) -> tuple[str, ...] | None:
    """Do not fill in an award, causal sequence, or a missing partial answer."""
    if mode == "partial":
        return _NEUTRAL
    if mode == "correct":
        return _ASSERTED.get(anchor, _NEUTRAL)
    return None
