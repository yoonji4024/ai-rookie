"""해석 근거 코퍼스 — 리포트 해석이 딛고 설 문헌·실험 근거.

설계 원칙
  - 모든 근거는 **ID + 원문(text)** 을 가진다. 검증 에이전트가 리포트의 주장을
    이 원문과 대조(entailment)해 판정하므로, 원문이 곧 진실원본이다.
  - LLM에게 자유 검색을 허용하지 않는다. 여기 있는 것만 근거로 쓴다.
    → 인용 환각을 구조적으로 차단.
  - 각 근거는 어느 축(axis)에 붙는지 태그를 단다. 축 점수 해석 시 그 축 근거만 검색.

출처 등급 (kind)
  exp   우리 실험 결과 — 재현 가능. 가장 강한 근거.
  bench 공개 벤치마크 수치 — 성능의 위치를 보여줌.
  clin  임상 지표 해석 — 지표가 인지저하와 어떻게 연결되는지.

⚠️ clin 항목은 널리 확립된 임상 소견을 요약한 것으로, **특정 논문 인용은 비워둠**.
   제안서·논문에 넣을 때는 팀이 실제 참고문헌을 확인해 `cite` 필드를 채울 것.
   (없는 인용을 지어내지 않기 위해 의도적으로 비움 — 검증 에이전트도 cite 없는
    항목은 "일반 임상 소견"으로만 인용하도록 프롬프트에서 제한한다.)
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Evidence:
    id: str                     # 인용 키. 리포트는 이 ID로만 인용한다.
    kind: str                   # exp / bench / clin
    axes: tuple[str, ...]       # 붙는 축 (빈 튜플이면 전체 공통)
    text: str                   # 원문 — 검증 대조 기준
    cite: str = ""              # 출처 표기 (실험은 우리 결과, 문헌은 서지정보)
    tags: tuple[str, ...] = field(default_factory=tuple)   # 검색 보조 키워드


# ─────────────────────────────────────────────────────────────
# ① 우리 실험 결과 (exp) — 재현 가능, 방어 가장 쉬움
# ─────────────────────────────────────────────────────────────
EXP: list[Evidence] = [
    Evidence(
        id="exp-kr-combined",
        kind="exp", axes=(),
        text=("한국어 DementiaBank Korean(HC 37 / MCI 40)에서 음향과 언어 피처를 결합해 "
              "정상 vs MCI 판별 AUC 0.928을 얻었다. 발화량 계열 피처를 제외한 보수적 "
              "조건에서도 AUC 0.813으로, 성능이 단순히 '말을 많이 하느냐'에서 오지 않음을 확인했다."),
        cite="본 연구 실험 (DementiaBank Korean, 화자 단위 교차검증)",
        tags=("한국어", "MCI", "결합", "AUC"),
    ),
    Evidence(
        id="exp-en-acoustic",
        kind="exp", axes=("발음 정확도", "침묵 시간", "발화 속도"),
        text=("영어 DementiaBank Pitt(정상 243 / 치매 260, 화자 271명)에서 전사 없이 "
              "원본 음성의 음향 피처만으로 정상 vs 치매 판별 AUC 0.765를 얻었다. "
              "언어 피처를 전혀 쓰지 않은 조건이다."),
        cite="본 연구 실험 (DementiaBank Pitt, 화자 단위 5-fold)",
        tags=("영어", "음향단독", "치매"),
    ),
    Evidence(
        id="exp-zh-acoustic",
        kind="exp", axes=("발음 정확도", "침묵 시간", "발화 속도"),
        text=("중국어 DementiaBank Lu(정상 26 / 치매 24)에서 음향 피처만으로 "
              "정상 vs 치매 판별 AUC 0.811을 얻었다. 한국어·영어·중국어 세 언어에서 "
              "음향 지표가 일관되게 판별력을 보였다."),
        cite="본 연구 실험 (DementiaBank Lu, 화자 단위 교차검증)",
        tags=("중국어", "교차언어", "음향단독"),
    ),
    Evidence(
        id="exp-pause-direction",
        kind="exp", axes=("침묵 시간",),
        text=("휴지(pause) 지표의 방향은 언어·과제에 따라 뒤집힌다. 한국어 인터뷰에서는 "
              "정상군이 더 자주 쉬었고, 영어·중국어 그림설명 과제에서는 치매군이 더 오래 쉬었다"
              "(휴지 비율 정상 0.411 vs 치매 0.519, 단변량 AUC 0.687). "
              "따라서 휴지의 좋고 나쁨을 고정 규칙으로 단정하지 않고, 학습 데이터에서 "
              "방향을 추정해 사용한다."),
        cite="본 연구 실험 (한국어/영어/중국어 비교)",
        tags=("휴지", "방향역전", "교차언어"),
    ),
    Evidence(
        id="exp-kr-disfluency",
        kind="exp", axes=("버벅임",),
        text=("한국어 특유의 비유창성 지표(어미 미완성, 단음절 파편 반복, 지시어 남용)를 "
              "추가하자 버벅임 축의 판별력이 AUC 0.690에서 0.879로 올랐다. 개별 지표는 "
              "어미 미완성 0.736, 단음절 파편 반복 0.726, 지시어 남용 0.692였으며, "
              "단음절 파편 반복은 MCI군에서 정상군의 약 19배로 나타났다."),
        cite="본 연구 실험 (DementiaBank Korean, 형태소 정규화)",
        tags=("버벅임", "한국어", "비유창성"),
    ),
    Evidence(
        id="exp-mci-limit",
        kind="exp", axes=(),
        text=("MCI(경도인지장애)는 음향 지표만으로는 잡기 어렵다. 영어 Delaware 코퍼스"
              "(정상 279 / MCI 159)에서 음향 단독 AUC는 0.598에 그쳤다. "
              "조기 신호 탐지에는 언어 피처와 회상 과제가 함께 필요하다."),
        cite="본 연구 실험 (DementiaBank Delaware, 화자 단위 교차검증)",
        tags=("MCI", "한계", "음향단독"),
    ),
    Evidence(
        id="exp-length-bias",
        kind="exp", axes=("문장 완성도", "발화 속도"),
        text=("발화량(총 말한 시간, 형태소 수)에 비례하는 피처는 인지 상태가 아니라 "
              "말을 많이 했는지를 반영할 수 있다. 이를 통제하기 위해 모든 언어 지표를 "
              "형태소 수로 정규화하고, 발화량 계열 피처는 점수 산출에서 제외한다."),
        cite="본 연구 설계 원칙 (편향 통제)",
        tags=("편향", "정규화", "발화량"),
    ),
]

# ─────────────────────────────────────────────────────────────
# ② 공개 벤치마크 (bench) — 성능의 위치
# ─────────────────────────────────────────────────────────────
BENCH: list[Evidence] = [
    Evidence(
        id="bench-adress-modality",
        kind="bench", axes=(),
        text=("ADReSS/ADReSSo 챌린지에서 알츠하이머 탐지 정확도는 언어 피처 단독 약 76.85%, "
              "음향 피처 단독 약 62.5%, 두 양식을 결합했을 때 약 85~89.6%로 보고되었다. "
              "음향과 언어를 함께 쓰는 것이 단일 양식보다 유리하다."),
        cite="ADReSS / ADReSSo Challenge (Interspeech)",
        tags=("벤치마크", "결합", "양식"),
    ),
    Evidence(
        id="bench-asr-robust",
        kind="bench", axes=(),
        text=("사람이 교정하지 않은 자동음성인식(ASR) 전사를 사용해도 알츠하이머 탐지 "
              "정확도가 약 84% 수준으로 보고되었다. 실사용 환경에서 자동 전사 기반 "
              "파이프라인이 성립할 수 있음을 시사한다."),
        cite="ADReSSo Challenge (비편집 ASR 조건)",
        tags=("ASR", "실사용", "강건성"),
    ),
]

# ─────────────────────────────────────────────────────────────
# ③ 임상 지표 해석 (clin) — 지표가 인지저하와 어떻게 연결되는가
#    ⚠️ cite 비움: 팀이 실제 참고문헌 확인 후 채울 것 (인용 환각 방지)
# ─────────────────────────────────────────────────────────────
CLIN: list[Evidence] = [
    Evidence(
        id="clin-pause-wordfinding",
        kind="clin", axes=("침묵 시간", "버벅임"),
        text=("내용어(명사·동사) 직전에 나타나는 휴지는 단어 찾기 어려움(word-finding "
              "difficulty)의 지표로 해석된다. 적절한 단어를 인출하는 데 시간이 더 걸리는 "
              "상태를 반영할 수 있다. 다만 휴지는 생각을 정리하는 정상적 과정이기도 하므로 "
              "단독으로 판단하지 않는다."),
        tags=("휴지", "단어찾기", "인출"),
    ),
    Evidence(
        id="clin-demonstrative",
        kind="clin", axes=("버벅임", "문장 완성도"),
        text=("구체적 명사 대신 '그거', '저기' 같은 지시어나 대명사를 반복해서 쓰는 양상은 "
              "어휘 인출의 어려움을 우회하는 전략으로 해석된다. 인지저하에서 비교적 "
              "이른 시기에 관찰될 수 있다."),
        tags=("지시어", "대명사", "우회"),
    ),
    Evidence(
        id="clin-lexical-diversity",
        kind="clin", axes=("문장 완성도",),
        text=("어휘 다양성 감소와 문장 구조의 단순화는 언어 산출 능력의 변화를 반영한다. "
              "다만 발화량이 적으면 어휘 다양성이 낮게 측정되므로, 길이 영향이 적은 "
              "지표(MATTR 등)를 함께 본다."),
        tags=("어휘다양성", "통사복잡도"),
    ),
    Evidence(
        id="clin-voice-quality",
        kind="clin", axes=("발음 정확도",),
        text=("음질 지표(HNR, CPP, jitter, shimmer)는 발성의 안정성과 명료도를 반영한다. "
              "이 지표들은 노화, 흡연, 감기, 녹음 환경 등 인지와 무관한 요인에도 영향을 "
              "받으므로, 인지 상태의 단독 근거로 쓰지 않는다."),
        tags=("음질", "교란요인", "발성"),
    ),
    Evidence(
        id="clin-speech-rate",
        kind="clin", axes=("발화 속도",),
        text=("발화 속도 저하는 언어 처리와 운동 실행의 변화를 함께 반영할 수 있다. "
              "개인차와 평소 말하기 습관의 영향이 크므로 절대값보다 같은 사람의 "
              "시간에 따른 변화가 더 의미 있다."),
        tags=("발화속도", "개인차", "종단"),
    ),
    Evidence(
        id="clin-order-recall",
        kind="clin", axes=("순서 회상",),
        text=("사건의 시간 순서를 재구성하는 능력은 일화기억(episodic memory)과 "
              "실행기능에 의존한다. 순서 오류의 유형(누락, 뒤바뀜, 없는 내용 삽입, "
              "단서 의존)은 서로 다른 인지 과정의 어려움을 시사할 수 있다."),
        tags=("순서회상", "일화기억", "실행기능"),
    ),
    Evidence(
        id="clin-not-diagnosis",
        kind="clin", axes=(),
        text=("음성·언어 지표는 선별(screening)의 보조 자료이며 진단이 아니다. "
              "확진에는 임상 면담, 신경심리검사, 영상 검사 등 종합적 평가가 필요하다. "
              "선별 결과는 전문의 상담 여부를 판단하는 참고 자료로만 쓴다."),
        tags=("면책", "진단아님", "선별"),
    ),
]

ALL: list[Evidence] = EXP + BENCH + CLIN
BY_ID: dict[str, Evidence] = {e.id: e for e in ALL}


def for_axis(axis: str) -> list[Evidence]:
    """해당 축에 붙는 근거 + 축 무관 공통 근거."""
    return [e for e in ALL if not e.axes or axis in e.axes]


def get(evidence_id: str) -> Evidence | None:
    return BY_ID.get(evidence_id)


if __name__ == "__main__":
    from collections import Counter
    print(f"근거 {len(ALL)}건  {dict(Counter(e.kind for e in ALL))}")
    axes = {a for e in ALL for a in e.axes}
    for a in sorted(axes):
        print(f"  {a:12s} {len(for_axis(a))}건")
    print(f"  (축 무관 공통 {len([e for e in ALL if not e.axes])}건)")
    no_cite = [e.id for e in ALL if not e.cite]
    print(f"\n⚠️ cite 비어있음 {len(no_cite)}건 — 팀이 실제 참고문헌 확인 필요:")
    print("  " + ", ".join(no_cite))
