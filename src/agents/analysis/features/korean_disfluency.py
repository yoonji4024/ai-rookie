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

# ⚠️ 청크 크기가 성능을 좌우한다.
#    3000자를 통째로 주면 믿:음이 마커를 하나도 못 센다(전부 0 반환).
#    반면 짧은 입력(수십 자)에서는 조사오류·자기수정·지시어남용을 근거까지 정확히 집어낸다.
#    → 발화 몇 개씩 잘라 분석하고 합산한다.
CHUNK_UTTERANCES = 10     # 1회 분석할 발화 수
MAX_CHARS = 800           # 청크 1개의 문자 상한(안전장치)

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
- 나타난 것은 **빠짐없이 모두** 세세요. 같은 마커가 여러 번 나오면 나온 횟수만큼 셉니다.
- 근거는 **전사 원문에서 그대로 인용**하세요. 없는 표현을 지어내지 마세요.
- 근거는 마커당 최대 3개만 적되, count는 실제 횟수 전부를 적으세요.

예시 (이 정도 세밀도로 세세요):
입력: "아니 , 이제 우리 , 저기 뭐야 거기 내 , 저기 뭐야 으 , 제가 즈 , 나 , 제 , 제가 저기 , 거기서 일하는 거 있어요 ."
출력: {"particle_error": {"count": 0, "evidence": []},
 "incomplete_ending": {"count": 0, "evidence": []},
 "self_repair": {"count": 1, "evidence": ["제가 즈 , 나 , 제 , 제가"]},
 "demonstrative_abuse": {"count": 3, "evidence": ["저기 뭐야 거기 내", "저기 뭐야 으", "저기 , 거기서"]},
 "word_finding": {"count": 2, "evidence": ["저기 뭐야", "저기 뭐야"]},
 "incoherence": {"count": 0, "evidence": []}}

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"particle_error": {"count": 0, "evidence": []},
 "incomplete_ending": {"count": 0, "evidence": []},
 "self_repair": {"count": 0, "evidence": []},
 "demonstrative_abuse": {"count": 0, "evidence": []},
 "word_finding": {"count": 0, "evidence": []},
 "incoherence": {"count": 0, "evidence": []}}"""


def _empty() -> dict:
    return {m: {"count": 0, "evidence": []} for m in MARKERS}


def _failed(reason: str) -> dict:
    return {**{m: {"count": None, "evidence": []} for m in MARKERS}, "_error": reason}


def validate_markers(value: object, text: str) -> dict:
    """Validate the output contract, not the semantic correctness of a marker."""
    if not isinstance(value, dict) or set(value) != set(MARKERS):
        raise LLMError("마커 출력의 필수 항목 불일치")
    result = {}
    for marker in MARKERS:
        item = value[marker]
        if not isinstance(item, dict) or set(item) != {"count", "evidence"}:
            raise LLMError("마커 항목의 구조 오류")
        count, evidence = item["count"], item["evidence"]
        if type(count) is not int or count < 0:
            raise LLMError("마커 횟수는 0 이상의 정수여야 함")
        if not isinstance(evidence, list) or len(evidence) > 3:
            raise LLMError("마커 근거 형식 오류")
        if (count == 0 and evidence) or (count > 0 and not evidence):
            raise LLMError("마커 횟수와 근거 불일치")
        if any(not isinstance(e, str) or not e.strip() or e not in text for e in evidence):
            raise LLMError("마커 근거가 전사 원문에 없음")
        result[marker] = {"count": count, "evidence": list(evidence)}
    return result


def analyze_chunk(text: str, raise_on_error: bool = False) -> dict:
    """짧은 텍스트 1개 분석 (청크 단위).

    ⚠️ 실패를 조용히 0으로 되돌리면 **'호출 실패'와 '마커 없음'을 구분할 수 없다.**
       (실제로 77명 전원 0이 나와 검증이 무의미해진 적 있음)
       → 실패 시 '_error'를 남기고, raise_on_error=True면 예외를 올린다.
    """
    try:
        text = text.strip()
        if not text:
            raise LLMError("분석할 전사가 없음")
        if len(text) > MAX_CHARS:
            raise LLMError("청크 길이 한도 초과: 전사를 잘라서 채점하지 않음")
        out = chat_json("midm", SYSTEM, f"[발화 전사]\n{text}\n\n마커를 찾아 JSON으로 답하세요.",
                        temperature=0.0)
        return validate_markers(out, text)
    except LLMError as e:
        if raise_on_error:
            raise
        # Provider/parser exception bodies may contain source text. Keep only type.
        return _failed("마커 측정 실패: " + type(e).__name__)


def _chunks(utterances: list[str], size: int = CHUNK_UTTERANCES) -> list[str]:
    """발화 목록 → 청크 텍스트 목록. 발화 수·글자 상한을 **둘 다** 지킨다.

    (담고 나서 검사하면 상한을 초과하므로, 담기 전에 검사한다)
    """
    out, cur = [], []
    for u in utterances:
        if cur and (len(cur) >= size or len(" ".join(cur + [u])) > MAX_CHARS):
            out.append(" ".join(cur))
            cur = []
        cur.append(u)
    if cur:
        out.append(" ".join(cur))
    return out


def analyze(utterances: list[str] | str, n_utterances: int = 0,
            raise_on_error: bool = False, verbose: bool = False) -> dict:
    """전사 → 마커 카운트 + 근거 (청크 분할 후 합산).

    utterances: 발화 목록(권장) 또는 전체 텍스트(문장 단위로 자동 분할).
    """
    if isinstance(utterances, str):
        import re
        utterances = [s for s in re.split(r"(?<=[.!?…])\s+", utterances.strip()) if s]

    parts = _chunks([u.strip() for u in utterances if u.strip()])
    if not parts:
        if raise_on_error:
            raise LLMError("분석할 전사가 없음")
        return {**_failed("분석할 전사가 없음"), "_n_chunks": 0}

    total = _empty()
    errors = []
    for i, p in enumerate(parts, 1):
        r = analyze_chunk(p, raise_on_error=raise_on_error)
        if err := r.pop("_error", None):
            errors.append(err)
            continue
        for m in MARKERS:
            total[m]["count"] += r[m]["count"]
            for ev in r[m]["evidence"]:
                if len(total[m]["evidence"]) < 5 and ev not in total[m]["evidence"]:
                    total[m]["evidence"].append(ev)
        if verbose:
            n = sum(r[m]["count"] for m in MARKERS)
            print(f"      청크 {i}/{len(parts)}: 마커 {n}개")

    if errors and len(errors) == len(parts):
        total = _failed(f"전 청크 실패: {errors[0]}")
    elif errors:
        total["_partial_error"] = f"{len(errors)}/{len(parts)} 청크 실패"
    total["_n_chunks"] = len(parts)
    return total


def to_features(markers: dict, n_utterances: int) -> dict:
    """마커 카운트 → 발화당 정규화 피처 (lg_kr_*).

    ⚠️ 발화 수로 나눠 **길이 편향을 제거**한다(총량 그대로 쓰면 말 많이 한 사람이 불리).
    """
    keys = [f"kr_{m}_rate" for m in MARKERS] + ["kr_disfluency_total"]
    if (markers.get("_error") or markers.get("_partial_error") or
            type(n_utterances) is not int or n_utterances <= 0):
        return dict.fromkeys(keys)
    counts = [markers.get(m, {}).get("count") for m in MARKERS]
    if any(type(count) is not int or count < 0 for count in counts):
        return dict.fromkeys(keys)
    feats = {f"kr_{m}_rate": count / n_utterances for m, count in zip(MARKERS, counts)}
    feats["kr_disfluency_total"] = sum(counts) / n_utterances
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
        utts = [u.text for u in r.par_utterances if u.text]
        m = analyze(utts, len(utts))
        err = m.get("_error")
        partial = m.get("_partial_error")
        n_chunks = m.get("_n_chunks", 0)
        cache[r.subject_id] = {
            "label": r.label,
            "n_utterances": len(utts),
            "n_chunks": n_chunks,
            "markers": {key: m[key] for key in MARKERS},
            "features": to_features(m, len(utts)),
            **({"error": err} if err else {}),
            **({"partial_error": partial} if partial else {}),
        }
        total = sum(m[key]["count"] or 0 for key in MARKERS)
        if err:
            n_fail += 1
            print(f"  [{i}/{len(recs)}] {r.subject_id} ⚠️ 실패: {err[:80]}")
        else:
            note = f" ⚠️{partial}" if partial else ""
            print(f"  [{i}/{len(recs)}] {r.subject_id} ({r.label}) "
                  f"마커 {total}개 / 청크 {n_chunks}{note}")
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

    recs = load_kang()
    hc = recs[0]
    mci = next((x for x in recs if x.label == "MCI"), recs[-1])
    hc_chunk = _chunks([u.text for u in hc.par_utterances if u.text])[0]
    mci_chunk = _chunks([u.text for u in mci.par_utterances if u.text])[1]
    samples = {
        "짧은 예문": "음 그거 있잖아 저거… 어제, 아니 그저께 병원에를 갔는데 뭐더라.",
        f"실제 MCI 청크({mci.subject_id})": mci_chunk,
        f"실제 HC 청크({hc.subject_id})": hc_chunk,
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
        utts = [u.text for u in r.par_utterances if u.text]
        print(f"\n[{r.subject_id}] {r.label} — 발화 {len(utts)}개")
        m = analyze(utts, len(utts), verbose=True)
        m.pop("_n_chunks", None)
        m.pop("_partial_error", None)
        if err := m.pop("_error", None):
            print(f"  ⚠️ {err}")
            continue
        for k, v in m.items():
            if v["count"]:
                print(f"  {k}: {v['count']}회 | 근거: {v['evidence'][:2]}")
        print(f"  피처: {to_features(m, len(utts))}")


if __name__ == "__main__":
    main()
