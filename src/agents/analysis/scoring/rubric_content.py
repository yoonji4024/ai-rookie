"""내용(semantic) 5축 스코어링 루브릭.

UI 스펙: 단어 수준 / 문맥 일치도 / 기억 정확도 / 시간·장소 지남력 / 논리 연결

⚠️ **발화 5축과 근본적으로 다른 점: 검증 가능성**
   발화 축은 Kang(음성+라벨)으로 AUC 검증이 됐다. 내용 축은 둘로 갈린다.

   [A] 전사 기반 — Kang으로 **검증 가능**
       단어 수준 · 시간·장소 지남력 · 논리 연결
       → HC 분포 기준 z 점수 (발화 축과 동일 방식)

   [B] 회상 기반 — Kang으로 **검증 불가**
       문맥 일치도 · 기억 정확도
       → 이벤트 그래프라는 **객관적 정답**이 있어 정오 판정 자체는 확실하다.
         다만 "이 점수가 MCI를 얼마나 가려내는가"는 **MCI 환자가 우리 콘텐츠를 보고
         회상한 데이터가 없어 미검증**이다. 제안서에 이 경계를 명시할 것.
       → 규준(HC 분포)이 아니라 **정답 대비 직접 환산**한다.

   이 구분을 흐리면 "검증된 성능"과 "설계상 타당한 지표"가 뒤섞인다.
"""
from __future__ import annotations

# ── [A] 전사 기반 축 — HC 규준 z 점수 (검증 가능) ────────────
AXES_TRANSCRIPT: dict[str, list[str]] = {
    "단어 수준": [
        "lg_mattr",            # 이동창 어휘다양성 (길이 영향 적음)
        "lg_ttr",              # 어휘다양성
        "lg_content_ratio",    # 내용어 비율
    ],
    "시간·장소 지남력": [
        "lg_cnt_time_specificity",     # 구체적 시간 / 전체 시간표현
        "lg_cnt_place_specificity",    # 구체적 장소 / 전체 장소표현
        "lg_cnt_time_specific_rate",
        "lg_cnt_place_specific_rate",
        "lg_cnt_place_deictic_rate",   # 지시어 의존 (AUC 0.682, 높을수록 비정상)
    ],
    "논리 연결": [
        "lg_cnt_connective_rate",      # 접속 표현
        "lg_idea_density",             # 정보 밀도
        "lg_pronoun_noun_ratio",       # 명사 대신 대명사 (지시 해소 곤란)
    ],
}

# ── [B] 회상 기반 축 — 정답 대비 직접 환산 (미검증) ──────────
# 이벤트 그래프가 정답이므로 규준 불필요. 0~100 환산식만 정의한다.
RECALL_AXES = ["문맥 일치도", "기억 정확도"]

# 문헌에서 반복적으로 중요성이 확인되는 회상·지남력을 중심으로 한 잠정 가중치.
# MEMFLIX 임상 표본으로 민감도/특이도를 검증한 확정 진단 배점은 아니며, 보호자용
# 관찰 총점을 만들기 위한 설계값이다. 문맥 일치도와 기억 정확도는 같은 네 문답에서
# 파생되므로 동일하게 크게 잡지 않고, 발화 길이·교육·STT 영향이 큰 단어 수준은
# 보조 지표로만 반영한다.
AXIS_WEIGHTS: dict[str, float] = {
    "기억 정확도": 0.40,
    "시간·장소 지남력": 0.25,
    "문맥 일치도": 0.15,
    "논리 연결": 0.15,
    "단어 수준": 0.05,
}

# 발화 축과 동일한 환산·등급 규칙을 쓴다 (일관성)
from src.agents.analysis.scoring.rubric import (  # noqa: E402
    GRADE_CUTS, Z_CLIP, Z_SHIFT, grade_of,
)

__all__ = [
    "AXES_TRANSCRIPT", "RECALL_AXES", "AXIS_WEIGHTS",
    "GRADE_CUTS", "Z_CLIP", "Z_SHIFT", "grade_of",
    "score_memory_accuracy", "score_context_match",
]


# ── 회상 기반 축 환산식 ──────────────────────────────────────
def score_memory_accuracy(recall: dict) -> tuple[int | None, dict]:
    """기억 정확도 — 얼마나 많이, 얼마나 순서대로 기억했는가.

    coverage(회상한 장면 비율)와 Kendall's tau(순서 일치도)를 반씩 반영.
    tau는 -1~1이므로 0~1로 옮긴다.
    """
    if recall.get("measurement_status") in {"partial", "unavailable"}:
        return None, {"설명": "자유 회상 매칭은 관찰값이며 완전한 의미 판정이 없어 점수 환산을 보류함"}
    cov = float(recall.get("coverage", 0.0))
    tau = float(recall.get("kendall_tau", 0.0))
    # 장면을 0~1개만 회상하면 순서 일치도는 정의할 수 없다. 이때 tau=0을
    # 중립(50점)으로 환산하면 아무것도 답하지 않아도 기억 점수가 25점이 된다.
    n_correct = int(recall.get("n_correct", 0))
    tau01 = (tau + 1) / 2 if n_correct >= 2 else 0.0
    score = int(round(100 * (0.5 * cov + 0.5 * tau01)))
    return score, {
        "coverage": round(cov, 3),
        "kendall_tau": round(tau, 3),
        "설명": f"장면 {recall.get('n_correct', 0)}개 회상, 순서 일치도 {tau:+.2f}",
    }


def score_context_match(recall: dict, n_scenes: int) -> tuple[int | None, dict]:
    """문맥 일치도 — 실제 콘텐츠에 있던 내용만 말했는가.

    intrusion(없던 내용을 말함)은 문맥 이탈이므로 감점.
    omission(빠뜨림)은 '기억 정확도' 쪽에서 이미 반영하므로 여기선 가볍게만 본다.
    """
    e = recall.get("errors", {})
    if recall.get("measurement_status") in {"partial", "unavailable"} or e.get("intrusion") is None:
        return None, {"intrusion": None, "설명": "침입 오류 여부를 확정하지 못해 문맥 점수 환산을 보류함"}
    intrusion = int(e.get("intrusion", 0))
    n_correct = int(recall.get("n_correct", 0))
    if n_correct == 0:
        return 0, {"intrusion": intrusion, "설명": "콘텐츠와 일치하는 장면을 확인하지 못함"}
    n = max(1, n_scenes)
    penalty = min(1.0, intrusion / n)          # 장면 수 대비 침입 비율
    score = int(round(100 * (1 - penalty)))
    return score, {
        "intrusion": intrusion,
        "설명": ("콘텐츠에 없던 내용 없음" if intrusion == 0
                 else f"콘텐츠에 없던 내용 {intrusion}건 언급"),
    }
