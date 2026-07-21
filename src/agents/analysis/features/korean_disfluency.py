"""한국어 비유창성 마커 추출 — KT 믿:음 2.0.

왜 LLM인가
  기존 버벅임 축은 정규식(음·어)·단어반복·휴지빈도만 봐서 AUC 0.684로 5축 중 가장 약했다.
  한국어 word-finding difficulty는 **정규식으로 못 잡는 형태**로 나타난다:
    - 조사 오류·생략      "병원에를 갔는데", "나 어제 병원 갔어" (조사 탈락)
    - 어미 미완성         "그래서 내가… " (문장이 끝나지 않음)
    - 자기 수정           "어제, 아니 그저께"
    - 지시어 남용         "그거 있잖아 저거"
    - 단어 찾기 실패      "뭐더라", "이름이 뭐지"
    - 의미 응집성 붕괴    문법은 맞는데 앞뒤가 안 이어짐
  → 한국어 특화 모델(믿:음)이 이 마커를 **찾고**, 점수는 **규칙**이 매긴다.

설계 원칙 (스코어링과 동일)
  - LLM은 마커 탐지·근거 제시만. 점수 산출은 규칙 → 재현·방어 가능.
  - 각 마커에 **원문 근거(evidence)** 를 남긴다.
  - 없는 마커를 만들지 않는다. 확신 없으면 세지 않는다.

사용:
    python3 -m src.agents.analysis.features.korean_disfluency --build   # Kang 전체 추출(캐시)
    python3 -m src.agents.analysis.features.korean_disfluency           # 샘플 확인
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.common.llm import LLMError, chat_json

CACHE = Path("data/kang_kr_disfluency.json")
MAX_CHARS = 3000          # 1회 분석 텍스트 상한(믿음 입력 제한 대비)

MARKERS = [
    "particle_error",      # 조사 오류·생략
    "incomplete_ending",   # 어미 미완성
    "self_repair",         # 자기 수정
    "demonstrative_abuse", # 지시어 남용
    "word_finding",        # 단어 찾기 실패 표현
    "incoherence",         # 의미 응집성 붕괴
]

SYSTEM = """당신은 한국어 발화의 비유창성(disfluency)을 분석하는 전문가입니다.
어르신의 발화 전사를 읽고, 아래 6가지 마커가 나타난 곳을 찾으세요.

마커 정의:
1. particle_error — 조사를 잘못 쓰거나 빠뜨림. 예: '병원에를 갔는데', '나 어제 병원 갔어'(조사 탈락)
2. incomplete_ending — 문장이 끝나지 않고 흐지부지 끊김. 예: '그래서 내가...'
3. self_repair — 말하다 스스로 고침. 예: '어제, 아니 그저께'
4. demonstrative_abuse — 구체적 명사 대신 지시어를 반복. 예: '그거 있잖아 저거'
5. word_finding — 단어가 안 떠오름을 드러내는 표현. 예: '뭐더라', '이름이 뭐지'
6. incoherence — 문법은 맞으나 앞뒤 내용이 이어지지 않음

규칙:
- 실제로 나타난 것만 세세요. 애매하면 세지 마세요.
- 각 마커마다 **전사 원문에서 그대로 인용한** 근거를 남기세요.
- 근거는 마커당 최대 3개까지만.

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"particle_error": {"count": 0, "evidence": []},
 "incomplete_ending": {"count": 0, "evidence": []},
 "self_repair": {"count": 0, "evidence": []},
 "demonstrative_abuse": {"count": 0, "evidence": []},
 "word_finding": {"count": 0, "evidence": []},
 "incoherence": {"count": 0, "evidence": []}}"""


def _empty() -> dict:
    return {m: {"count": 0, "evidence": []} for m in MARKERS}


def analyze(transcript: str, n_utterances: int = 0, raise_on_error: bool = False) -> dict:
    """전사 → 마커 카운트 + 근거.

    ⚠️ 실패를 조용히 0으로 되돌리면 **'호출 실패'와 '마커 없음'을 구분할 수 없다.**
       (실제로 77명 전원 0이 나와 검증이 무의미해진 적 있음)
       → 실패 시 결과에 '_error'를 남기고, raise_on_error=True면 예외를 올린다.
    """
    text = transcript.strip()[:MAX_CHARS]
    if not text:
        return _empty()
    try:
        out = chat_json("midm", SYSTEM, f"[발화 전사]\n{text}\n\n마커를 찾아 JSON으로 답하세요.",
                        temperature=0.0)
    except LLMError as e:
        if raise_on_error:
            raise
        r = _empty()
        r["_error"] = str(e)[:300]
        return r

    res = _empty()
    for m in MARKERS:
        v = out.get(m) or {}
        if isinstance(v, dict):
            try:
                res[m]["count"] = max(0, int(v.get("count", 0)))
            except (TypeError, ValueError):
                pass
            ev = v.get("evidence") or []
            res[m]["evidence"] = [str(e) for e in ev][:3] if isinstance(ev, list) else []
    return res


def to_features(markers: dict, n_utterances: int) -> dict:
    """마커 카운트 → 발화당 정규화 피처 (lg_kr_*).

    ⚠️ 발화 수로 나눠 **길이 편향을 제거**한다(총량 그대로 쓰면 말 많이 한 사람이 불리).
    """
    n = max(1, n_utterances)
    feats = {f"kr_{m}_rate": markers.get(m, {}).get("count", 0) / n for m in MARKERS}
    feats["kr_disfluency_total"] = sum(
        markers.get(m, {}).get("count", 0) for m in MARKERS) / n
    return feats


# ── Kang 전체 추출 (캐시) ────────────────────────────────────
def build_cache(out: Path = CACHE, limit: int | None = None) -> dict:
    from src.preprocessing.kang_loader import load_kang

    cache = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    recs = load_kang()
    if limit:
        recs = recs[:limit]

    n_fail = 0
    for i, r in enumerate(recs, 1):
        if r.subject_id in cache:
            continue
        m = analyze(r.par_text, len(r.par_utterances))
        err = m.pop("_error", None)
        cache[r.subject_id] = {
            "label": r.label,
            "n_utterances": len(r.par_utterances),
            "markers": m,
            "features": to_features(m, len(r.par_utterances)),
            **({"error": err} if err else {}),
        }
        total = sum(v["count"] for v in m.values())
        if err:
            n_fail += 1
            print(f"  [{i}/{len(recs)}] {r.subject_id} ⚠️ 실패: {err[:80]}")
        else:
            print(f"  [{i}/{len(recs)}] {r.subject_id} ({r.label}) 마커 {total}개")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    if n_fail:
        print(f"\n⚠️ {n_fail}/{len(recs)}건 호출 실패 — 마커 0은 '없음'이 아니라 '측정 실패'입니다.")
    return cache


def load_cache(path: Path = CACHE) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def debug_call() -> None:
    """믿:음 원시 응답 확인 — 실패 원인(형식·길이·파라미터) 진단용."""
    from src.common.llm import chat
    from src.preprocessing.kang_loader import load_kang

    r = load_kang()[0]
    samples = {
        "짧은 예문": "음 그거 있잖아 저거… 어제, 아니 그저께 병원에를 갔는데 뭐더라.",
        f"실제 전사({r.subject_id}, {MAX_CHARS}자 제한)": r.par_text[:MAX_CHARS],
    }
    for name, text in samples.items():
        print(f"\n{'=' * 60}\n[{name}] 입력 {len(text)}자")
        try:
            raw = chat("midm", SYSTEM, f"[발화 전사]\n{text}\n\n마커를 찾아 JSON으로 답하세요.",
                       temperature=0.0)
            print(f"원시 응답 ({len(raw)}자):\n{raw[:600]}")
        except Exception as e:
            print(f"⚠️ 호출 실패: {type(e).__name__}: {str(e)[:300]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="Kang 전체 추출")
    ap.add_argument("--limit", type=int, help="처음 N명만")
    ap.add_argument("--debug", action="store_true", help="믿:음 원시 응답 확인")
    a = ap.parse_args()

    if a.debug:
        debug_call()
        return

    if a.build:
        c = build_cache(limit=a.limit)
        print(f"\n캐시 저장: {CACHE} ({len(c)}명)")
        return

    from src.preprocessing.kang_loader import load_kang

    for r in load_kang()[:2]:
        m = analyze(r.par_text, len(r.par_utterances))
        print(f"\n[{r.subject_id}] {r.label} — 발화 {len(r.par_utterances)}개")
        for k, v in m.items():
            if v["count"]:
                print(f"  {k}: {v['count']}회 | 근거: {v['evidence'][:2]}")
        print(f"  피처: {to_features(m, len(r.par_utterances))}")


if __name__ == "__main__":
    main()
