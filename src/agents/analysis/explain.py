"""KT 믿:음 — 탐지 근거 제시 (CLAUDE.md §8의 지정 역할).

역할 분담
  - 분류기(XGBoost): 확률과 전체 모델의 피처 중요도를 **계산**한다.
  - 믿:음: 그 수치가 **무엇을 뜻하는지 한국어로 설명**한다.
  - 솔라: 보호자용 리포트 문장을 만든다.
  → 믿:음은 관찰 수치를 설명한다. 전역 중요도를 개인의 기여로 해석하지 않는다.

철칙
  - 주어진 피처·수치만 사용. 없는 근거를 만들지 않는다.
  - 진단명 금지. "이런 신호가 관찰된다"까지만.
  - 피처 이름을 그대로 쓰지 않고 **사람이 이해할 말**로 바꿔 설명한다.
"""
from __future__ import annotations

import json

import numpy as np

from src.common.llm import LLMError, chat_json

# 피처명 → 사람이 이해할 설명 (믿:음에 넘길 사전)
FEATURE_GLOSS = {
    "ac_total_speech_dur": "총 말한 시간",
    "ac_phonation_time": "실제 소리를 낸 시간",
    "ac_pause_ratio": "말하는 중 쉬는 비율",
    "ac_pause_rate": "말하다 멈추는 빈도",
    "ac_pause_time_ratio": "전체 중 침묵이 차지하는 비율",
    "ac_pause_dur_mean": "한 번 쉴 때의 평균 길이",
    "ac_pause_dur_std": "쉬는 길이의 들쭉날쭉함",
    "ac_long_pause_rate": "0.5초 이상 긴 침묵의 빈도",
    "ac_voiced_seg_rate": "말이 끊겼다 이어지는 빈도",
    "ac_voiced_run_mean": "한 번에 이어 말하는 길이",
    "ac_hnr": "목소리의 맑기(잡음 대비 배음)",
    "ac_cpp": "목소리의 또렷함·주기성",
    "ac_jitter_local": "음높이의 미세 떨림",
    "ac_shimmer_local": "목소리 크기의 미세 떨림",
    "ac_shimmer_apq3": "목소리 크기 떨림(단기)",
    "ac_shimmer_apq5": "목소리 크기 떨림(중기)",
    "ac_f0_mean": "평균 음높이",
    "ac_f0_std": "음높이의 변동 폭",
    "ac_f0_range": "가장 높은 음과 낮은 음의 차이",
    "ac_f0_cv": "음높이 변동의 상대적 크기",
    "ac_jitter": "음높이의 미세 떨림",
    "ac_jitter_rap": "음높이 떨림(단기 평균)",
    "ac_jitter_ppq5": "음높이 떨림(중기 평균)",
    "ac_shimmer": "목소리 크기의 미세 떨림",
    "ac_spec_zcr_mean": "소리의 거칠기",
    "lg_n_morphemes": "말한 단어의 총량",
    "lg_n_utterances": "말한 횟수",
    "lg_ttr": "쓰는 낱말의 다양성(전체 기준)",
    "lg_idea_density": "문장에 담긴 정보의 밀도",
    "lg_pronoun_ratio": "대명사 사용 비율",
    "lg_pronoun_noun_ratio": "구체적 명사 대신 대명사를 쓰는 정도",
    "lg_utt_dur_mean": "한 번 말할 때 걸리는 시간",
    "lg_turn_gap_std": "답하기까지 걸리는 시간의 들쭉날쭉함",
    "lg_utt_len_mean": "한 번 말할 때의 길이",
    "lg_utt_len_std": "말 길이의 들쭉날쭉함",
    "lg_mattr": "쓰는 낱말의 다양성",
    "lg_content_ratio": "의미를 담은 낱말의 비율",
    "lg_filler_rate": "'음·어' 같은 채움말 비율",
    "lg_repeat_rate": "같은 말 반복 비율",
    "lg_speech_rate": "말하는 속도",
    "lg_turn_gap_mean": "질문에 답하기까지 걸린 시간",
    "lg_krr_incomplete_ending_rate": "문장을 끝맺지 못하고 흐리는 빈도",
    "lg_krr_fragment_repeat_rate": "'제가, 즈, 나, 제' 처럼 짧은 조각을 되풀이하는 빈도",
    "lg_krr_demonstrative_rate": "'그거, 저기' 같은 지시어에 기대는 빈도",
}

SYSTEM = """당신은 발화 분석에서 제공된 관찰 수치를 설명하는 역할입니다.

주어진 것: 모델 출력과 관찰 항목. 모델 출력은 임상 진단이 아닙니다.
할 일: 각 항목의 뜻과 실제 제공된 값을 설명하세요.

반드시 지킬 것:
1. 질병명이나 진단을 단정하지 마세요. '진단이 아닙니다'라는 한계 설명은 필요합니다.
2. value_available=false 또는 null은 미측정입니다. 실제 0과 구분하고 값을 만들지 마세요.
3. 피처의 영어 이름을 쓰지 말고, 함께 준 우리말 설명을 쓰세요.
4. reference_available=false이면 비교할 참조가 없다고 쓰세요. reference_mean이 있어도 제공된 평균 하나일 뿐,
   정상 범위나 임상 기준이 아닙니다. 평균과의 산술 비교만 가능하며 정상/비정상을 판정하지 마세요.
5. importance_scope=global_model은 전체 모델의 중요도 순위입니다. 이 사람의 결과에 미친 크기·방향이나
   원인을 계산한 값이 아닙니다. unspecified는 범위가 확인되지 않았습니다. 둘 다 개별 기여로 설명하지 마세요.
6. 제공되지 않은 단위·범위·원인·품질을 추측하지 마세요. 확률이 미제공이면 채우지 마세요.

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"evidence": [{"observation": "제공된 관찰 또는 미측정 사실(우리말)", "meaning": "항목의 뜻과 해석 한계", "value_note": "제공된 값·참조 평균 또는 비교 불가"}],
 "overall": "2문장 이내 종합. 진단 아님을 명시."}"""


def top_contributions(model, feature_names: list[str], x: np.ndarray,
                      reference: dict | None = None, k: int = 5) -> list[dict]:
    """전역 중요도 상위 항목과 관찰값. 개별 예측 기여도는 계산하지 않는다.

    공개 함수 이름은 기존 호출자와의 호환을 위해 유지한다.
    """
    from src.agents.analysis.explanation_contract import observation_item

    if type(k) is not int or k < 0:
        raise ValueError('k must be a nonnegative integer')
    imp = getattr(model, "feature_importances_", None)
    if imp is None:
        return []
    imp = np.asarray(imp, dtype=float)
    x = np.asarray(x, dtype=object)
    if (imp.ndim != 1 or x.ndim != 1 or len(imp) != len(x)
            or len(imp) != len(feature_names)):
        raise ValueError('feature names, importance and observation vector must align')
    if not np.isfinite(imp).all() or (imp < 0).any():
        raise ValueError('global feature importance must be finite and nonnegative')
    order = np.argsort(imp)[::-1][:k]
    out = []
    for i in order:
        name = feature_names[i]
        item = {
            "feature": name,
            "설명": FEATURE_GLOSS.get(name, name),
            "value": x[i],
            "importance": round(float(imp[i]), 4),
            "importance_scope": "global_model",
        }
        if reference and name in reference:
            item["reference_mean"] = reference[name]
        item = observation_item(item)
        for key in ('value', 'reference_mean'):
            if item[key] is not None:
                item[key] = round(item[key], 4)
        out.append(item)
    return out


def explain_detection(prediction: dict, contributions: list[dict]) -> dict:
    """모델 출력과 관찰값 → 형식 검사된 한국어 설명 (의미 검증은 별개)."""
    from src.agents.analysis.explanation_contract import explanation_payload, validated_explanation

    try:
        payload = explanation_payload(prediction, contributions)
    except (ValueError, TypeError):
        return {"error": "invalid_explanation_input", "evidence": [], "overall": ""}
    try:
        output = chat_json(
            "midm", SYSTEM,
            f"{json.dumps(payload, ensure_ascii=False, indent=1, allow_nan=False)}\n\n"
            "각 항목의 근거를 설명하는 JSON을 작성하세요.",
            temperature=0.1,
        )
    except LLMError:
        return {"error": "explanation_generation_failed", "evidence": [], "overall": ""}
    return validated_explanation(output)


if __name__ == "__main__":
    from src.agents.analysis.classifier import Classifier
    from src.agents.analysis.evaluate import cross_validate  # noqa: F401

    d = np.load("data/kang_features.npz", allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    ids = [str(i) for i in d["ids"]]

    clf = Classifier(feature_names=names).fit(X, y)
    hc_mean = {n: float(X[y == 0, i].mean()) for i, n in enumerate(names)}

    # MCI 확률이 가장 높은 화자로 시연
    probs = clf.model.predict_proba(X)[:, 1]
    i = int(np.argmax(probs))
    pred = clf.predict(X[i])
    contrib = top_contributions(clf.model, names, X[i], hc_mean, k=5)

    print(f"대상 {ids[i]} (실제 {'MCI' if y[i] else 'HC'})")
    print(f"판단: {pred['label']} (확률 {pred['prob'][pred['label']]:.2f})\n")
    print("전역 중요도 상위 관찰 항목 (개별 기여 아님):")
    for c in contrib:
        ref = f" / 참조 평균 {c['reference_mean']}" if c['reference_available'] else " / 참조 없음"
        print(f"  {c['설명']}: {c['value']}{ref}")

    print("\n믿:음 근거 설명:")
    ex = explain_detection(pred, contrib)
    if ex.get("error"):
        print(f"  ⚠️ {ex['error']}")
    else:
        for e in ex.get("evidence", []):
            print(f"  · {e.get('observation')}")
            print(f"    → {e.get('meaning')} ({e.get('value_note','')})")
        print(f"\n  종합: {ex.get('overall')}")
