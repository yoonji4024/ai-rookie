"""발화(speech) 5축 스코어링 루브릭.

UI 스펙: 버벅임 / 침묵 시간 / 발화 속도 / 발음 정확도 / 문장 완성도
        각 0~100점, 총점 + 등급(정상·위험·심각).

설계 원칙
1. **방향은 데이터에서 결정한다.** 직관("침묵 많으면 나쁨")과 Kang 데이터가 반대인 축이 있음
   (HC pause_ratio 0.093 > MCI 0.035 — HC가 더 자주 쉼). 임의 가정 대신 학습 fold의
   HC/MCI 평균차로 부호를 정하고, 검증 단계에서 라벨과의 정합을 확인한다.
2. **편향 피처 제외.** total_speech_dur·phonation_time·n_morphemes 등 '말 길이' 계열은
   인터뷰 길이 차이를 반영할 수 있어 점수 산출에서 뺀다(정규화 지표만 사용).
3. **HC 기준 정규화.** 각 피처를 HC 분포의 z로 바꾸고, 점수 = 100·Φ(z+1).
   → HC 평균 ≈ 84점, HC 대비 -1SD ≈ 50점. 신경심리 규준의 -1SD 컷 관행과 정합.
4. **높을수록 정상.** 모든 축은 점수가 높을수록 HC에 가깝다.

주의: 버벅임·문장완성도는 전사 기반 지표(filler/repeat/발화길이)를 쓰지만, 이는 '무엇을
말했나(semantic)'가 아니라 '어떻게 말했나(발화 형태)'라 발화 파트 범위로 본다.
"""
from __future__ import annotations

# ─────────────────────────────────────────────────────────────
# 축 정의 — 축 이름 → 구성 피처 목록
#   피처명은 build_feature_vector 규약(ac_* 음향 / lg_* 언어)을 따른다.
# ─────────────────────────────────────────────────────────────
AXES: dict[str, list[str]] = {
    "버벅임": [
        "lg_filler_rate",      # 간투사(음/어) 비율
        "lg_repeat_rate",      # 인접 단어 반복
        "ac_pause_rate",       # 발화 내부 머뭇거림 빈도
    ],
    "침묵 시간": [
        "ac_pause_ratio",
        "ac_pause_time_ratio",
        "ac_long_pause_rate",  # ≥0.5s 긴 휴지
        "ac_pause_dur_mean",
        "lg_turn_gap_mean",    # 질문~응답 간격(응답 지연 근사)
    ],
    "발화 속도": [
        "lg_speech_rate",      # 음절/초
        "ac_voiced_seg_rate",  # 초당 발화 분절 수
        "ac_voiced_run_mean",  # 분절 평균 길이
    ],
    "발음 정확도": [
        "ac_hnr",              # 배음 대 잡음비(맑기)
        "ac_cpp",              # 켑스트럼 피크 돌출도(명료도)
        "ac_jitter_local",     # 음높이 떨림
        "ac_shimmer_local",    # 크기 떨림
        "ac_shimmer_apq3",
    ],
    "문장 완성도": [
        "lg_utt_len_mean",     # 발화당 형태소 수
        "lg_utt_len_std",
        "lg_content_ratio",    # 내용어 비율
        "lg_mattr",            # 이동창 어휘다양성(길이 영향 적음)
    ],
}

# 총점 가중치 (기본: 균등). 검증에서 축별 판별력 확인 후 조정 가능.
AXIS_WEIGHTS: dict[str, float] = {k: 1.0 for k in AXES}

# 점수 산출에서 반드시 제외 — '말 길이' 편향 계열
EXCLUDED_FEATURES = {
    "ac_total_speech_dur",
    "ac_phonation_time",
    "lg_n_morphemes",
    "lg_n_utterances",
}

# 등급 컷 (점수 → 등급). 100·Φ(z+1) 환산 기준:
#   70점 ≈ HC 평균 -0.48SD / 50점 ≈ HC 평균 -1.0SD
GRADE_CUTS = [
    (70, "정상"),
    (50, "위험"),
    (0, "심각"),
]

# 점수 환산 파라미터
Z_SHIFT = 1.0      # 100·Φ(z + Z_SHIFT) — HC 평균이 84점이 되도록
Z_CLIP = 3.0       # 극단값 클리핑(±3SD)


def grade_of(score: float) -> str:
    """점수 → 등급 문자열."""
    for cut, label in GRADE_CUTS:
        if score >= cut:
            return label
    return GRADE_CUTS[-1][1]


def all_rubric_features() -> list[str]:
    """루브릭이 사용하는 전체 피처(중복 제거, 제외 목록 반영)."""
    feats: list[str] = []
    for members in AXES.values():
        for f in members:
            if f not in EXCLUDED_FEATURES and f not in feats:
                feats.append(f)
    return feats
