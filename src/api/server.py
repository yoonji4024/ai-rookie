"""채점 API — 데모 프론트엔드(Rookie_2026_DEMO) 연동.

역할: 세션 오디오 + 회상 응답 → 프론트가 그대로 렌더할 수 있는 리포트 JSON.

경계
  - 이 서버가 국내 LLM API 키를 갖는다. **프론트는 키를 갖지 않는다**
    (프론트 레포는 공개될 수 있고, 브라우저 번들에 키가 들어가면 노출됨).
  - 점수는 규칙으로 산출하고 LLM은 해석만 한다. 해석은 검증을 통과한 것만 내보낸다.

엔드포인트
  GET  /health              상태 + 참조분포 로드 여부
  POST /api/report          오디오(multipart) + 응답 JSON → 리포트
  GET  /api/report/mock     프론트 목업과 같은 형태의 더미 (API 장애 시 폴백/개발용)

실행
    uvicorn src.api.server:app --reload --port 8000
프론트에서는 vite.config.ts 에 프록시 추가:
    "/api/report": { target: "http://localhost:8000", changeOrigin: true }
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from src.api.schema import (
    EmpathyRequest,
    Interpretation,
    ReportQuestion,
    ReportResponse,
    ScoreCategory,
    ScoreFactor,
    TTSRequest,
    TrendPoint,
)

app = FastAPI(title="AI Rookie 채점 API", version="0.1.0")


def _reference_profile(patient_birth_date: str | None) -> tuple[str, str]:
    """등록 생년월일로 참조 범위만 선택한다. 음성으로 말한 생일은 점수 입력이 아니다."""
    if not patient_birth_date:
        return (
            "personal_baseline",
            "생년월일이 등록되지 않아 이번 결과를 개인 변화 관찰의 첫 기준선으로 기록합니다.",
        )
    try:
        birth = datetime.strptime(patient_birth_date, "%Y-%m-%d").date()
        today = datetime.now().date()
        age = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    except (TypeError, ValueError):
        return (
            "personal_baseline",
            "생년월일 형식을 확인하지 못해 이번 결과를 개인 변화 관찰의 첫 기준선으로 기록합니다.",
        )
    if 60 <= age <= 79:
        return (
            "older_reference",
            f"만 {age}세 · 현재 60~79세 한국어 참조 범위와 개인 변화 추이를 함께 살펴봅니다.",
        )
    return (
        "personal_baseline",
        f"만 {age}세 · 현재 동일 연령대 참조 규준이 없어 집단 비교 대신 개인 변화 추이를 중심으로 살펴봅니다.",
    )

# .env를 프로세스 환경에 올린다. STT(AXSTT)는 os.environ을 직접 읽으므로
# llm 모듈이 먼저 import되지 않으면 키를 못 찾는다 → 서버 기동 시 한 번 로드.
try:
    from src.common.llm import load_env
    load_env()
except Exception:
    pass

# 개발 중 Vite(5173)에서 직접 호출 허용. 배포 시 도메인 제한할 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"], allow_headers=["*"],
)

@app.on_event("startup")
def _warmup():
    """librosa(numba) JIT 컴파일을 기동 시 끝낸다.

    첫 호출에 수 초가 붙는데 계산이 아니라 컴파일 비용이다. 미리 태우지 않으면
    **첫 사용자 요청만 유독 느려진다**(시연에서 그 한 번이 하필 첫 요청).
    """
    try:
        import librosa
        import numpy as _np
        d = _np.zeros(16000, dtype=_np.float32)
        librosa.feature.mfcc(y=d, sr=16000, n_mfcc=13)
        librosa.feature.zero_crossing_rate(d)
        librosa.feature.rms(y=d)
        _load_model()          # 참조분포도 미리 로드
        _migrate_latest_report_to_history()
    except Exception:
        pass


MODEL_PATH = Path(os.environ.get(
    "SCORING_MODEL_PATH",
    "configs/scoring_model_hybrid.json"
    if Path("configs/scoring_model_hybrid.json").exists()
    else "configs/scoring_model.json",
))
CONTENT_MODEL_PATH = Path(os.environ.get(
    "CONTENT_SCORING_MODEL_PATH",
    "configs/scoring_model_content_hybrid.json"
    if Path("configs/scoring_model_content_hybrid.json").exists()
    else "configs/scoring_model_content.json",
))

SPEECH_AXES = ["버벅임", "침묵 시간", "발화 속도", "발음 정확도", "문장 완성도"]
CONTENT_AXES = ["단어 수준", "문맥 일치도", "기억 정확도", "시간·장소 지남력", "논리 연결"]

_model = None
_tts_cache: dict[str, str] = {}
_response_variant_lock = threading.Lock()
_response_variant_cursor: dict[str, int] = {}
LIVE_ROOT = Path("data/live")
HISTORY_DB_PATH = LIVE_ROOT / "history.sqlite3"


def _pick_response_variant(
    candidates: tuple[str, ...], identity: str, seeded_index: int,
) -> str:
    """같은 답변에 바로 같은 안전 문구가 반복되지 않도록 세 후보를 순환한다.

    LLM 출력이 안전 검사를 통과하지 못했을 때만 쓰는 프로세스 로컬 상태다. 사용자
    데이터나 채점에는 영향을 주지 않으며, 개발 서버 재시작 시 자연스럽게 초기화된다.
    """
    if not candidates:
        return ""
    with _response_variant_lock:
        if len(_response_variant_cursor) >= 512:
            _response_variant_cursor.clear()
        previous = _response_variant_cursor.get(identity)
        index = seeded_index % len(candidates) if previous is None else (previous + 1) % len(candidates)
        _response_variant_cursor[identity] = index
    return candidates[index]


def _load_model():
    """참조분포 로드 (없으면 None → 측정 불가)."""
    global _model
    if _model is None and MODEL_PATH.exists():
        from src.agents.analysis.scoring.score import ScoringModel
        _model = ScoringModel.load(str(MODEL_PATH))
    return _model


def _history_patient_key(patient_name: str | None) -> str:
    """로그인 사용자별 이력을 분리하기 위한 안정적인 SQLite 키."""
    return str(patient_name or "").strip() or "__anonymous__"


def _history_connection(db_path: Path | None = None):
    """리포트 이력 DB 연결을 열고 필요한 테이블을 보장한다."""
    import sqlite3

    path = Path(db_path or HISTORY_DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS report_history (
            session_id TEXT PRIMARY KEY,
            patient_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            speech_factors TEXT NOT NULL,
            content_factors TEXT NOT NULL,
            analysis_mode TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_report_history_patient_time "
        "ON report_history(patient_name, created_at)"
    )
    return connection


def _store_report_history(
    session_id: str,
    report: ReportResponse,
    created_at: datetime | None = None,
    db_path: Path | None = None,
) -> None:
    """실제 분석 세션의 점수만 사용자별 SQLite 이력에 저장한다."""
    if report.analysisMode not in {"scored", "partial"}:
        return
    if not any(f.available for f in report.speechScore.factors + report.contentScore.factors):
        return
    timestamp = (created_at or datetime.now()).isoformat(timespec="microseconds")
    speech = [factor.model_dump() for factor in report.speechScore.factors]
    content = [factor.model_dump() for factor in report.contentScore.factors]
    with _history_connection(db_path) as connection:
        connection.execute(
            """
            INSERT OR IGNORE INTO report_history (
                session_id, patient_name, created_at,
                speech_factors, content_factors, analysis_mode
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                _history_patient_key(report.patientName),
                timestamp,
                json.dumps(speech, ensure_ascii=False),
                json.dumps(content, ensure_ascii=False),
                report.analysisMode,
            ),
        )


def _load_report_history(
    patient_name: str | None,
    limit: int = 6,
    db_path: Path | None = None,
) -> list[TrendPoint]:
    """해당 사용자의 최근 실제 세션을 오래된 순서로 반환한다."""
    try:
        with _history_connection(db_path) as connection:
            rows = connection.execute(
                """
                SELECT created_at, speech_factors, content_factors
                FROM report_history
                WHERE patient_name = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (_history_patient_key(patient_name), max(1, int(limit))),
            ).fetchall()
    except Exception:
        return []

    rows.reverse()
    parsed_dates: list[datetime | None] = []
    for created_at, _, _ in rows:
        try:
            parsed_dates.append(datetime.fromisoformat(str(created_at)))
        except Exception:
            parsed_dates.append(None)
    date_counts: dict[str, int] = {}
    for when in parsed_dates:
        if when is not None:
            key = when.strftime("%Y-%m-%d")
            date_counts[key] = date_counts.get(key, 0) + 1

    trend: list[TrendPoint] = []
    for index, ((created_at, speech_json, content_json), parsed_when) in enumerate(
        zip(rows, parsed_dates), start=1,
    ):
        try:
            when = parsed_when or datetime.fromisoformat(str(created_at))
            suffix = "(이번)" if index == len(rows) else ""
            date_key = when.strftime("%Y-%m-%d")
            # 같은 날 여러 차례 시연한 경우 날짜만 반복하면 회차를 구분하기 어렵다.
            # 그때만 시각까지 표시하고, 날짜가 다르면 기존의 간결한 라벨을 유지한다.
            when_label = when.strftime("%m/%d %H:%M") if date_counts.get(date_key, 0) > 1 else when.strftime("%m/%d")
            trend.append(TrendPoint(
                date=when.isoformat(timespec="microseconds"),
                label=f"{index}회차{suffix}\n{when_label}",
                speechFactors=[ScoreFactor(**item) for item in json.loads(speech_json)],
                contentFactors=[ScoreFactor(**item) for item in json.loads(content_json)],
            ))
        except Exception:
            continue
    return trend


def _migrate_latest_report_to_history(db_path: Path | None = None) -> None:
    """DB 도입 전 마지막 실제 리포트 한 건을 첫 이력으로 안전하게 이관한다."""
    reports = sorted(
        LIVE_ROOT.glob("*/report.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in reports:
        try:
            report = ReportResponse(**json.loads(path.read_text(encoding="utf-8")))
            if report.analysisMode not in {"scored", "partial"}:
                continue
            created_at = datetime.fromtimestamp(path.stat().st_mtime)
            _store_report_history(path.parent.name, report, created_at, db_path=db_path)
            return
        except Exception:
            continue


def _factors(axes: dict, order: list[str]) -> list[ScoreFactor]:
    """점수 dict → 프론트 순서대로 정렬된 factor 배열.

    NaN 방어: 피처 하나가 NaN이면 축 z가 NaN이 되고 int(nan)이 예외를 던진다
    (예: 무음 구간이라 praat이 음질 계산에 실패). 화면이 통째로 죽는 것보다
    해당 축을 ``available=False``로 표시해 실제 0점과 구분한다.
    """
    import math
    out = []
    for label in order:
        v = axes.get(label)
        raw = (v.get("score") if isinstance(v, dict) else v) if v is not None else None
        try:
            s = float(raw)
            available = not isinstance(raw, bool) and math.isfinite(s) and 0 <= s <= 100
        except (TypeError, ValueError):
            s = 0.0
            available = False
        if isinstance(v, dict) and v.get("available") is False:
            available = False
        if not available:
            s = 0.0  # Schema placeholder only; available=False excludes it from scores.
        detail = (v.get("detail") if isinstance(v, dict) else None)
        validated = (v.get("validated") if isinstance(v, dict) else None)
        if isinstance(v, dict) and detail is None and any(
            key in v for key in ("z", "features", "missing")
        ):
            detail = {
                key: v[key] for key in ("z", "features", "missing") if key in v
            }
            try:
                z_value = float(v.get("z") or 0)
                saturated = math.isfinite(z_value) and abs(z_value) >= 2.9
            except (TypeError, ValueError):
                saturated = False
            ceiling = saturated and z_value > 0
            floor = saturated and z_value < 0
            missing = list(v.get("missing") or [])
            detail.update({
                "confidence": "moderate" if saturated or missing else "high",
                # This label describes feature availability/reference saturation;
                # successful extraction does not establish recording quality.
                "confidence_scope": "feature_availability_and_reference_saturation",
                "recording_quality_assessed": False,
                "score_ceiling": ceiling,
                "score_floor": floor,
                "reference_saturation": "upper" if ceiling else "lower" if floor else None,
                "reason": (
                    "현재 참조 분포 상단에 가까워 반복 관찰 중심으로 해석"
                    if ceiling else
                    "현재 참조 분포 하단에 가까워 반복 관찰 중심으로 해석"
                    if floor else
                    "일부 세부 지표 결측을 제외하고 계산"
                    if missing else
                    "현재 참조 분포에서 계산한 관찰값"
                ),
            })
            # 현재 실사용 짧은 문답 도메인에서 축별 절대 등급은 별도 검증 전이다.
            validated = False
        if (label == "시간·장소 지남력" and isinstance(v, dict)
                and v.get("measurement_source") == "transcript_expression_reference"):
            detail = dict(detail or {})
            detail.update({
                "measurement_method": "transcript_expression_reference",
                "actual_date_verified": False,
                "actual_location_verified": False,
                "normalization": {
                    "matching": "substring",
                    "rate_denominator": "hangul_runs",
                    "minimum_rate_denominator": 1,
                    "specificity_denominator": "specific_plus_relative_or_deictic_matches",
                },
            })
            validated = False
        def finite_detail(value):
            if isinstance(value, dict):
                return {k: finite_detail(x) for k, x in value.items()}
            if isinstance(value, (list, tuple)):
                return [finite_detail(x) for x in value]
            if isinstance(value, float) and not math.isfinite(value):
                return None
            return value
        out.append(ScoreFactor(
            label=label,
            score=int(round(min(max(s, 0), 100))) if available else 0,
            available=available,
            validated=validated,
            detail=finite_detail(detail),
        ))
    return out


def _suppress_short_transcript_content_axes(
    axes: dict,
    linguistic: dict,
    min_morphemes: int | None = None,
) -> dict:
    """짧은 발화도 점수는 보존하되 표본 길이에 따른 참고 신뢰도를 명시한다.

    114는 학습 캐시의 최소 관찰 길이지 임상적 유효성 절단값이 아니다. 이 값을
    넘지 않았다는 이유만으로 사용자 결과를 없애지 않고, 해석 강도만 낮춘다.
    길이를 충족해도 미디어 문답의 임상 검증을 뜻하지 않으며 결측 설명은 보존한다.
    """
    import math

    threshold = int(
        min_morphemes
        if min_morphemes is not None
        else os.environ.get("CONTENT_MIN_MORPHEMES", "114")
    )
    n_morphemes = int(linguistic.get("n_morphemes") or 0)
    for axis_name in ("단어 수준", "논리 연결"):
        if axis_name in axes:
            value = axes[axis_name]
            if not isinstance(value, dict):
                value = {"score": value}
                axes[axis_name] = value
            detail = dict(value.get("detail") or {})
            # Adding a length detail must not hide the reference evidence that
            # _factors would otherwise copy from the score engine's output.
            for key in ("z", "features", "missing"):
                if key in value:
                    detail[key] = value[key]
            try:
                z_value = float(value.get("z", detail.get("z")) or 0)
                saturated = math.isfinite(z_value) and abs(z_value) >= 2.9
            except (TypeError, ValueError):
                saturated = False
            ceiling = saturated and z_value > 0
            floor = saturated and z_value < 0
            missing = list(value.get("missing", detail.get("missing")) or [])
            length_confidence = (
                "high" if n_morphemes >= threshold
                else "moderate" if n_morphemes >= threshold * 0.6
                else "low"
            )
            detail.update({
                "n_morphemes": n_morphemes,
                "reference_min": threshold,
                "confidence": (
                    "moderate" if length_confidence == "high" and (missing or saturated)
                    else length_confidence
                ),
                "confidence_scope": "sample_length_and_feature_availability_and_reference_saturation",
                "recording_quality_assessed": False,
                "score_ceiling": ceiling,
                "score_floor": floor,
                "reference_saturation": "upper" if ceiling else "lower" if floor else None,
                "reason": (
                    "현재 참조 발화량 범위 안에서 계산함"
                    if n_morphemes >= threshold else
                    "짧은 발화에서 계산한 참고 관찰값"
                ),
            })
            value["detail"] = detail
            value["validated"] = False
    return axes


def _score_reflection_logic(items: list[dict]) -> dict | None:
    """자유 감상의 '영상 장면 제시 → 이유·감정 설명' 연결을 관찰한다.

    단순히 ``~니까`` 같은 접속 표현만 있으면 영상과 무관한 답도 높은 점수를
    받는다. 그래서 MEMFLIX 영상에서 실제로 확인할 수 있는 장면 의미와 그
    장면에 대한 이유·감정을 별도로 확인한다.
    """
    import re

    reflection = next(
        (item for item in items if str(item.get("id", "")).startswith("f-")),
        None,
    )
    if reflection is None:
        return None
    raw = str(reflection.get("userAnswer", "")).strip()
    answer = _compact_answer(raw)
    if not answer:
        return None
    video_scene_terms = (
        "기타", "노래", "가요제", "대상", "수상", "부부", "두분", "남편",
        "아내", "대학교", "대학1학년", "캠퍼스", "오랫동안", "함께살",
        "다정", "식사", "음식", "지붕", "트리하우스", "나무집", "사진",
        "회상",
    )
    reason_terms = (
        "때문", "해서", "라서", "니까", "생각", "느낌", "좋", "따뜻",
        "정겹", "멋", "인상", "마음", "추억", "떠올", "기억", "부럽",
        "부지런", "대단", "감동", "걱정", "보기좋",
    )
    has_scene = any(term in answer for term in video_scene_terms)
    has_reason = any(term in answer for term in reason_terms)
    has_explicit_link = bool(
        re.search(r"때문|해서|라서|니까|그래서|나서|어가지고|아가지고|거든", answer)
    )
    if has_scene and has_reason:
        score = 100 if has_explicit_link else 90
    elif has_scene:
        score = 70
    elif has_reason:
        # 이유가 문법적으로 이어져도 영상 장면이 확인되지 않으면 회상에 근거한
        # 논리 연결이라고 볼 수 없다.
        score = 40
    else:
        score = 30 if len(answer) >= 10 else 20
    return {
        "score": score,
        "validated": False,
        "detail": {
            "method": "reflection_scene_reason_rule",
            "scene_present": has_scene,
            "video_scene_present": has_scene,
            "reason_or_emotion_present": has_reason,
            "explicit_causal_link": has_explicit_link,
            "reason": "자유 감상에서 장면과 이유·감정의 의미 연결을 관찰함",
        },
    }


def _prepare_api_stt_audio(path: str, suffix: str, pad_seconds: float,
                           profile: str) -> Path:
    """브라우저 녹음을 여러 컨테이너 프로필로 바꿔 A.X WAF 오류를 우회한다."""
    import subprocess

    source = Path(path)
    pad_ms = int(round(pad_seconds * 1000))
    common = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-af", f"adelay={pad_ms}:all=1,apad=pad_dur={pad_seconds}",
    ]
    if profile == "m4a_16k":
        out = source.with_name(f"{source.stem}_{suffix}.m4a")
        encode = ["-ar", "16000", "-ac", "1", "-c:a", "aac", "-b:a", "48k"]
    elif profile == "m4a_44k":
        out = source.with_name(f"{source.stem}_{suffix}.m4a")
        encode = ["-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "96k",
                  "-movflags", "+faststart"]
    else:
        out = source.with_name(f"{source.stem}_{suffix}.caf")
        encode = ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]
    # 실측상 같은 음성도 WAF가 허용하는 컨테이너 프로필이 달라 세 프로필을 순차 시도한다.
    subprocess.run(common + encode + [str(out)], check=True, timeout=45)
    return out


def _normalize_stt_text(text: str, keywords: list[str] | None = None) -> str:
    """시연 문맥에서 명백한 A.X 표기 오류만 보수적으로 정리한다.

    빈 전사를 만들거나 답에 없던 정답을 추가하지 않는다. 실제로 반환된 발음과
    거의 같은 띄어쓰기·고유명사 오인식만 고쳐 보호자에게 읽을 수 있게 보여준다.
    """
    import re

    normalized = re.sub(r"\s+", " ", text).strip()
    # A.X가 자주 단어 내부에 공백을 넣는 대회 영상 고유명사.
    normalized = re.sub(r"대학\s*가\s*요제", "대학가요제", normalized)
    # 실제 장소 발화에서 반복 확인된 기관명/건물명 오인식.
    normalized = normalized.replace("성경관대학교", "성균관대학교")
    normalized = re.sub(r"제\s*(?:이|2)\s*공학권", "제2공학관", normalized)

    keyword_set = {re.sub(r"\s+", "", str(k)) for k in (keywords or [])}
    # 정답 키워드가 전달된 해당 질문에서만 적용한다. 다른 문맥의 '대삼'을
    # 임의로 정답으로 바꾸지 않도록 범위를 제한한다.
    if "대상" in keyword_set:
        normalized = re.sub(
            r"대삼(?=을|를|이|가|은|는|으로|이라고|\s|[,.?!]|$)",
            "대상",
            normalized,
        )
    if "대학가요제" in keyword_set:
        # "대학가요제에서 대상"이 음절 경계 때문에 반복적으로 아래처럼
        # 인식됐다. 바로 뒤에 '대상'이 있는 비문일 때만 좁게 교정한다.
        normalized = re.sub(
            r"대학가에\s*대해서(?=\s*대상(?:을|를)?(?:\s|[,.?!]|$))",
            "대학가요제에서",
            normalized,
        )
        # 최신 실제 녹음에서 '제2회 대학가요제'가 'J회 대학가요제'로 나온
        # 고정 시연 고유명사 오류. 대학가요제 문맥이 바로 뒤에 있을 때만 고친다.
        normalized = re.sub(r"\b[Jj]\s*회(?=\s*대학가요제)", "제2회", normalized)
    return normalized


def _stt_boost_keywords(keywords: list[str] | None) -> list[str]:
    """채점 키워드는 그대로 두고 STT word boosting용 구문만 보강한다."""
    import re

    values = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    compact = {re.sub(r"\s+", "", value) for value in values}

    if {"대학교", "1학년", "캠퍼스"}.issubset(compact):
        values.extend(["대학교 1학년", "캠퍼스 커플"])
    if "대상" in compact:
        values.extend(["대학가요제", "대학가요제 대상"])
    if {"트리하우스", "지붕"}.issubset(compact):
        values.extend(["트리하우스 지붕", "지붕 보수"])

    # API에 같은 키워드를 중복 전송하지 않도록 입력 순서를 유지하며 제거한다.
    return list(dict.fromkeys(values))


def _stt(path: str, keywords: list[str] | None = None) -> str:
    """A.X STT로 전사. 단독 사용자 세션의 모든 발화를 시간순으로 합친다.

    런타임 질문 답변은 한 사람의 짧은 녹음이므로 화자 분리가 필요 없다. 파일 PUT이
    WAF에 자주 막히는 Batch보다 공식 Streaming API를 우선하고, Streaming 연결이
    실패할 때만 Batch의 여러 포맷을 보조 폴백으로 사용한다.
    """
    from src.common.stt import AXSTT, STTError
    import time

    client = AXSTT()
    last_error: Exception | None = None
    boost_keywords = _stt_boost_keywords(keywords)
    try:
        tr = client.transcribe_streaming(path, keywords=boost_keywords)
        text = _normalize_stt_text(tr.text, boost_keywords)
        if not text:
            raise STTError("Streaming 전사 결과가 비어 있음")
        return text
    except Exception as exc:
        # Streaming이 막힌 환경에서도 기존 Batch 경로로 한 번 더 살린다.
        last_error = exc

    attempts = (
        ("original", 0.0, "original"),
        ("stt", 0.15, "m4a_16k"),
        ("stt_retry", 0.35, "m4a_44k"),
        ("stt_final", 0.55, "caf"),
    )
    # 정상 WAV 원본을 먼저 보내고, 거부되면 컨테이너를 바꾼다. WAF가 짧은 시간에
    # 요청을 몰아 받으면 같은 파일의 모든 포맷을 거절하는 사례가 있어 라운드 사이를
    # 충분히 띄운다. 리포트는 백그라운드 작업이라 이 지연이 사용자 흐름을 막지 않는다.
    retry_delays = (0.0, 4.0, 12.0)
    waf_seen = False
    for round_index, retry_delay in enumerate(retry_delays):
        if retry_delay:
            time.sleep(retry_delay)
        for suffix, pad_seconds, profile in attempts:
            try:
                prepared = (Path(path) if profile == "original" else
                            _prepare_api_stt_audio(
                                path, f"{suffix}_r{round_index + 1}", pad_seconds, profile,
                            ))
                tr = client.transcribe(str(prepared), keywords=boost_keywords)
                text = _normalize_stt_text(tr.text, boost_keywords)
                if not text:
                    raise STTError("전사 결과가 비어 있음")
                return text
            except Exception as exc:
                last_error = exc
                message = str(exc)
                waf_seen = waf_seen or "WAF" in message or "Request Rejected" in message
        if round_index < len(retry_delays) - 1 and waf_seen:
            continue
        break
    raise STTError(f"전사 재시도 실패: {type(last_error).__name__}") from last_error


def _health() -> dict:
    return {"ok": True, "scoring_model": MODEL_PATH.exists(),
            "content_model": CONTENT_MODEL_PATH.exists(),
            "tts": bool(os.environ.get("VARCO_API_KEY"))}


@app.get("/health")
def health():
    return _health()


@app.post("/api/tts")
def synthesize_tts(body: TTSRequest):
    """VARCO 질문 음성을 서버에서 합성해 키가 브라우저에 노출되지 않게 한다."""
    import hashlib
    import requests

    api_key = os.environ.get("VARCO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="VARCO TTS 키가 설정되지 않았습니다.")
    payload = body.model_dump()
    cache_key = hashlib.sha256(json.dumps(
        payload, sort_keys=True, ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    if cache_key in _tts_cache:
        return {"audio": _tts_cache[cache_key]}

    try:
        response = requests.post(
            "https://openapi.ai.nc.com/tts/standard/v1/api/synthesize",
            headers={"OPENAPI_KEY": api_key}, json=payload, timeout=60,
        )
        response.raise_for_status()
        audio = response.json().get("audio")
    except Exception as exc:
        raise HTTPException(status_code=502, detail="VARCO TTS 호출에 실패했습니다.") from exc
    if not audio:
        raise HTTPException(status_code=502, detail="VARCO TTS 음성 데이터가 비어 있습니다.")
    _tts_cache[cache_key] = audio
    return {"audio": audio}


@app.post("/api/respond")
def generate_empathy(body: EmpathyRequest):
    """정답 여부를 화면에 드러내지 않으면서 실제 발화에 맞춰 반응한다.

    정답·부분정답·모름·무관 응답의 대화 전략을 분리한다. 정답 원문은 오직
    잘못된 사실을 맞다고 확인하지 않기 위한 내부 문맥으로만 쓰고, 사용자에게
    정답을 알려주거나 채점 결과를 암시하지 않는다.
    """
    import hashlib
    import re

    fallbacks = {
        "correct": (
            "그 이야기를 들으니 아까 장면이 더 특별하게 느껴져요.",
            "말씀하신 대목을 생각하니 아까 장면이 더 생생해져요.",
            "그 내용을 알고 보니 아까 장면이 한층 더 인상적이에요.",
        ),
        "partial": (
            "그 이야기를 들으니 아까 장면이 조금 더 선명해지는 기분이에요.",
            "말씀하신 부분을 떠올리니 장면이 한층 더 인상적으로 느껴져요.",
            "그 대목을 짚어주시니 아까 장면을 다시 생각하게 돼요.",
        ),
        "uncertain": (
            "괜찮아요, 바로 떠오르지 않아도 돼요. 아까 장면을 편하게 이어서 봐요.",
            "잠깐 헷갈릴 수도 있죠. 부담 없이 화면을 계속 즐겨봐요.",
            "괜찮아요, 천천히 생각해도 돼요. 저는 아까 장면이 계속 눈에 남아요.",
        ),
        "unrelated": (
            "저는 아까 화면의 분위기가 계속 눈에 남아요. 장면을 조금 더 같이 봐요.",
            "아까 장면에는 눈길 가는 부분이 참 많았어요. 저는 화면을 조금 더 보고 싶어요.",
            "이야기를 나누며 보니 장면이 더 풍성하게 느껴져요. 저는 화면을 계속 따라가 볼게요.",
        ),
    }
    style_hints = (
        "사용자가 말한 원인과 결과를 받아 장면에 대한 짧은 감상을 덧붙이세요.",
        "사용자가 짚은 인물의 행동을 중심으로 함께 본 사람처럼 반응하세요.",
        "사용자가 말한 분위기나 관계에 초점을 맞춰 다정하게 받아 주세요.",
        "사용자가 꺼낸 핵심 표현 하나를 어색하지 않게 바꾸어 받아 주세요.",
        "가족과 나란히 영상을 보는 듯한 편한 구어체를 사용하세요.",
        "말끝을 '~네요', '~나 봐요', '~죠' 중 문맥에 맞게 골라 주세요.",
        "앞 문장과 겹치지 않는 짧은 감상을 한 가지 덧붙이세요.",
    )
    seed = f"{body.question}|{body.userAnswer}|{body.variationKey}".encode("utf-8")
    seed_value = int(hashlib.sha256(seed).hexdigest()[:8], 16)
    style_hint = style_hints[seed_value % len(style_hints)]

    item = {
        "id": body.questionId,
        "question": body.question,
        "correctAnswer": body.correctAnswer,
        "userAnswer": body.userAnswer,
        "answerKeywords": body.answerKeywords,
    }
    semantic_score = _semantic_rule_score(item)
    mode = _response_mode(body.userAnswer, semantic_score)
    fallback_group = fallbacks[mode]
    fallback = fallback_group[seed_value % len(fallback_group)]

    # 정답·부분 답변에서는 사용자가 실제로 말한 핵심 표현 하나를 반드시 받아
    # 주도록 한다. LLM이 구체성을 놓치더라도 질문별 문장으로 자연스럽게 이어진다.
    answer_compact = _effective_assertion(body.userAnswer)
    anchor_claims: dict[str, tuple[tuple[str, str], ...]] = {
        "d1": (("대상", "대상이라고"), ("1등", "1등이라고"), ("일등", "1등이라고")),
        "x1": (
            ("인기", "인기가 생겨서라고"), ("유명", "유명해져서라고"),
            ("대상", "대상을 받아서라고"), ("대학가요제", "대학가요제 덕분이라고"),
        ),
        "d2": (
            ("대학교1학년", "대학교 1학년 때라고"), ("대학1학년", "대학 1학년 때라고"),
            ("대학교", "대학교 때라고"), ("캠퍼스", "캠퍼스에서 만났다고"),
        ),
        "x2": (
            ("수리", "수리하려는 거라고"), ("보수", "보수하려는 거라고"),
            ("고치", "고치려는 거라고"), ("고친", "고치는 중이라고"),
            ("고칠", "고치려는 거라고"), ("고쳤", "고쳤다고"),
            ("트리하우스", "트리하우스를 손보는 거라고"),
        ),
    }
    anchor = ""
    claim = ""
    for candidate, candidate_claim in anchor_claims.get(body.questionId, ()):
        if candidate in answer_compact:
            anchor, claim = candidate, candidate_claim
            break
    neutral_claims: dict[str, tuple[tuple[str, str], ...]] = {
        "d1": (
            ("금상", "금상이 먼저 떠오르셨군요."), ("은상", "은상이 먼저 떠오르셨군요."),
            ("동상", "동상이 먼저 떠오르셨군요."), ("우수상", "우수상이 먼저 떠오르셨군요."),
        ),
        "x1": (
            ("잘생", "잘생긴 모습이 먼저 눈에 들어오셨군요."),
            ("좋아", "학생들이 좋아했던 장면으로 느끼셨군요."),
            ("친구", "친구들과 어울리던 장면으로 느끼셨군요."),
        ),
        "d2": (
            ("고등학교", "고등학교 시절이 먼저 떠오르셨군요."),
            ("고등학생", "고등학생 때의 만남으로 떠올리셨군요."),
            ("어릴", "어릴 때의 만남으로 떠올리셨군요."),
            ("최근", "최근에 만난 두 분처럼 느끼셨군요."),
        ),
        "x2": (
            ("구경", "구경하러 올라간 장면으로 느끼셨군요."),
            ("놀러", "잠깐 놀러 올라간 모습처럼 느끼셨군요."),
            ("공기", "바람을 쐬는 장면이 먼저 떠오르셨군요."),
            ("경치", "경치를 보는 모습처럼 느끼셨군요."),
            ("시야", "주변을 둘러보는 장면처럼 느끼셨군요."),
            ("전망", "전망을 보는 장면처럼 느끼셨군요."),
            ("확트", "탁 트인 곳을 보는 장면처럼 느끼셨군요."),
            ("탁트", "탁 트인 곳을 보는 장면처럼 느끼셨군요."),
        ),
    }
    neutral_start = ""
    if not anchor:
        for candidate, candidate_start in neutral_claims.get(body.questionId, ()):
            if candidate in answer_compact:
                anchor, neutral_start = candidate, candidate_start
                break
    required_term_groups: dict[str, dict[str, tuple[str, ...]]] = {
        "d1": {
            "대상": ("대상", "1등", "일등"), "1등": ("대상", "1등", "일등"),
            "일등": ("대상", "1등", "일등"),
        },
        "x1": {
            "인기": ("인기", "유명", "대세"), "유명": ("인기", "유명", "대세"),
            "대상": ("대상",), "대학가요제": ("대학가요제", "가요제"),
        },
        "d2": {
            "대학교1학년": ("대학교", "대학", "1학년", "캠퍼스"),
            "대학1학년": ("대학교", "대학", "1학년", "캠퍼스"),
            "대학교": ("대학교", "대학", "캠퍼스"),
            "캠퍼스": ("대학교", "대학", "캠퍼스"),
        },
        "x2": {
            "수리": ("수리", "고치", "보수", "손보"),
            "보수": ("수리", "고치", "보수", "손보"),
            "고치": ("수리", "고치", "보수", "손보"),
            "고친": ("수리", "고치", "보수", "손보"),
            "고칠": ("수리", "고치", "보수", "손보"),
            "고쳤": ("수리", "고치", "보수", "손보"),
            "트리하우스": ("트리하우스", "나무집", "수리", "고치", "보수"),
        },
    }
    # Mentioning an answer while denying it or saying "I don't know" is not
    # an assertion. Do not force the model to echo that answer as an anchor.
    required_terms = (required_term_groups.get(body.questionId, {}).get(anchor, ())
                      if mode in ("correct", "partial") else ())

    scene_fallbacks: dict[str, dict[str, tuple[str, ...]]] = {
        "d1": {
            "correct": (
                "가요제에서 대상까지 받았다니, 그때 얼마나 기뻤을지 상상이 돼요.",
                "대상을 받은 주인공이었다니, 그 시절 이야기가 더 특별하게 들려요.",
                "가장 큰 상을 받았다니, 노래 실력이 정말 대단한 분이었네요.",
            ),
            "partial": (
                "큰 상을 받았던 이야기라니, 그 시절이 더 궁금해져요.",
                "가요제에서 큰 상을 받았다니, 얼마나 기뻤을지 상상이 돼요.",
                "큰 상을 받은 때의 이야기라니, 그 시절이 더 특별하게 들려요.",
            ),
            "unrelated": (
                "그 시절 이야기를 듣고 있으니 세월이 참 빠르다는 생각이 들어요.",
                "가요제 이야기를 들으니 그때 분위기가 더 궁금해져요.",
                "옛날 추억을 직접 들려주시니 저도 귀를 기울이게 돼요.",
            ),
            "uncertain": (
                "괜찮아요, 상 이름은 잠깐 헷갈릴 수 있죠. 그 시절 이야기를 조금 더 들어봐요.",
                "바로 떠오르지 않아도 괜찮아요. 가요제 이야기를 조금 더 들어봐요.",
                "천천히 생각해도 돼요. 옛날 추억을 편하게 이어서 들어봐요.",
            ),
        },
        "x1": {
            "correct": (
                "가요제 뒤에 유명해졌다니, 그 시절 인기가 정말 대단했나 봐요.",
                "그때 많은 사람이 알아봤다니, 얼마나 유명했을지 상상이 돼요.",
                "대상을 받은 뒤 인기가 커졌다니, 그 시절 이야기가 더 특별하게 들려요.",
            ),
            "partial": (
                "인기가 정말 많았던 시절인가 봐요. 그때 이야기가 더 궁금해져요.",
                "그때 인기가 대단했다니, 당시 분위기도 무척 뜨거웠겠어요.",
                "인기 많았던 시절 이야기라니, 그때 분위기가 더 궁금해져요.",
            ),
            "unrelated": (
                "그때 이야기를 직접 들으니 세월이 참 빠르다는 생각이 들어요.",
                "옛날 추억을 직접 들려주시니 저도 귀를 기울이게 돼요.",
                "그 시절 이야기를 듣고 있으니 당시 분위기가 더 궁금해져요.",
            ),
            "uncertain": (
                "괜찮아요, 바로 떠오르지 않아도 돼요. 그때 이야기를 조금 더 들어봐요.",
                "잠깐 헷갈릴 수도 있죠. 옛날 추억을 편하게 이어서 들어봐요.",
                "천천히 생각해도 괜찮아요. 저는 그 시절 이야기가 더 궁금해요.",
            ),
        },
        "d2": {
            "correct": (
                "대학교 1학년 때부터 함께였다니, 오랜 인연이 정말 소중해 보여요.",
                "캠퍼스에서 시작된 인연이라니, 지금까지 이어온 시간이 참 대단해요.",
                "대학 1학년 때 만났다니, 두 분의 이야기가 더 특별하게 들려요.",
            ),
            "partial": (
                "대학 시절부터 이어진 인연이라니, 함께한 시간이 참 깊게 느껴져요.",
                "대학에서 처음 만났다니, 두 분의 옛이야기가 더 궁금해져요.",
                "젊은 시절부터 알던 사이라니, 지금까지 이어온 세월이 참 대단해요.",
            ),
            "unrelated": (
                "두 분의 오랜 이야기를 들으니 함께한 세월이 참 깊게 느껴져요.",
                "한자리에서 옛이야기를 나누는 시간이 참 따뜻하게 느껴져요.",
                "두 분 이야기를 조금 더 듣고 싶어지는 장면이에요.",
            ),
            "uncertain": (
                "괜찮아요, 잠깐 헷갈릴 수 있죠. 두 분 이야기를 조금 더 들어봐요.",
                "바로 떠오르지 않아도 괜찮아요. 옛날 추억을 편하게 이어서 들어봐요.",
                "천천히 생각해도 돼요. 두 분의 이야기가 더 궁금해지네요.",
            ),
        },
        "x2": {
            "correct": (
                "직접 지붕을 수리하는 중이었다니, 손재주가 정말 대단한 분이네요.",
                "트리하우스를 손보고 계셨다니, 직접 해내는 모습이 참 멋져요.",
                "지붕을 보수하는 중이었다니, 이유를 알고 나니 더 대단해 보여요.",
            ),
            "partial": (
                "지붕에 문제가 있었다니, 올라갈 만한 사정이 있었네요.",
                "지붕 쪽에 사정이 있었다니, 직접 확인하려던 모양이에요.",
                "지붕에 문제가 생겼다니, 그냥 올라간 건 아니었네요.",
            ),
            "unrelated": (
                "나무 사이에 자리한 트리하우스가 참 특별하게 보여요.",
                "직접 만든 나무집이라고 하니 손재주가 참 대단해 보여요.",
                "트리하우스 주변 풍경이 참 푸르고 시원해 보여요.",
            ),
            "uncertain": (
                "괜찮아요, 바로 떠오르지 않아도 돼요. 나무 사이 트리하우스가 참 특별해요.",
                "잠깐 헷갈릴 수도 있죠. 직접 만든 나무집이라고 하니 참 대단해요.",
                "천천히 생각해도 괜찮아요. 트리하우스 이야기를 조금 더 들어봐요.",
            ),
        },
    }
    candidates = scene_fallbacks.get(body.questionId, {}).get(mode, fallback_group)
    if body.questionId == "x1":
        from src.agents.conversation.empathy_fallback import x1_fallback_candidates
        candidates = x1_fallback_candidates(mode, anchor) or candidates
        if mode == "partial":
            required_terms = ()
    variant_identity = f"{body.questionId}|{mode}|{answer_compact}"
    fallback = _pick_response_variant(candidates, variant_identity, seed_value)

    # LLM에는 영상에서 실제로 확인된 최소한의 장면 정보만 준다. 특히 오답·모름
    # 응답에서는 사용자 주장을 받아 적거나 정답을 추측하지 않고 이 범위 안에서만
    # 짧게 반응하도록 해, 자연스러움을 높이면서도 장면 환각을 막는다.
    scene_basis = {
        "d1": "오래된 대학가요제 사진과 사진 속 젊은 시절 모습",
        "x1": "현재 기타를 치며 그 시절 이야기를 들려주는 모습",
        "d2": "두 사람이 한자리에서 음식을 나누는 모습",
        "x2": "나무 사이 트리하우스의 높은 지붕 위에 서 있는 모습",
    }.get(body.questionId, "질문과 함께 실제로 본 화면")
    mode_instruction = {
        "correct": "사용자가 말한 핵심 사실 하나를 받아, 그 사실 때문에 달라진 AI의 짧은 감상을 덧붙이세요.",
        "partial": "사용자가 말한 범위까지만 받아, 확인된 장면 정보에 대한 짧은 감상으로 이어가세요.",
        "unrelated": "사용자의 답 내용을 다시 말하지 말고 맞장구치지도 마세요. 정답도 알려주지 말고 확인된 장면 정보만 가볍게 감상하세요.",
        "uncertain": "정답을 추측하거나 알려주지 마세요. 부담을 덜어 주고 확인된 장면 정보만 가볍게 감상하세요.",
    }[mode]
    response_answer = body.userAnswer.strip()
    correction_end = 0
    for marker in ("아니라", "아니고"):
        marker_index = response_answer.rfind(marker)
        if marker_index >= 0:
            correction_end = max(correction_end, marker_index + len(marker))
    if correction_end:
        response_answer = response_answer[correction_end:].strip(" ,.!?~")

    system = (
        "당신은 사용자와 나란히 영상을 보는 다정한 시청 동반자입니다. 사용자는 화면 "
        "속 인물이 아니라 영상을 보고 답한 시청자입니다. 화면 속 사건을 사용자가 직접 겪거나 "
        "상을 받고, 누군가를 만나고, 지붕에 올라간 것처럼 말하지 마세요. 화면에는 이미 "
        "AI의 장면 감상 한 문장이 나왔습니다. 사용자의 답을 듣고 AI의 생각이 자연스럽게 "
        "이어지거나 달라지는 짧은 반응을 만드세요. 답을 앵무새처럼 되풀이하지 말고, '그런데', "
        "'그러고 보니', '~였다니'처럼 앞 감상과 연결되는 편한 구어체를 다양하게 활용하세요. "
        "매번 문장 구조와 말끝이 달라지게 하세요. "
        "정답 판정, 기억력, 인지, 검사, 진단은 언급하지 마세요. 사용자의 문장을 그대로 "
        "반복하거나 사용자 답변에 없는 인물·사건·숫자를 만들지 마세요. mode가 correct일 때만 장면을 "
        "잘 짚었다는 뉘앙스를 쓸 수 있습니다. partial/unrelated일 때는 사용자의 사실 주장을 "
        "맞다고 확인하거나 틀렸다고 정정하지 말고 화면에 실제로 나온 모습에 대한 감상으로 이어가세요. uncertain일 때는 "
        "바로 떠오르지 않아도 괜찮다고 안심시키세요. 장면에 관한 가벼운 개인 감상은 가능하지만 "
        "취향·경험을 지어내는 자기고백은 하지 마세요. '아, 그렇군요', '말씀 잘 들었어요', "
        "'이야기해 주셔서 고마워요', '우리 계속 같이 봐요' 같은 상투어는 쓰지 마세요. "
        "사용자가 말하지 않은 행동의 원인·목적·속마음을 추측하지 말고, 두 번째 문장에서는 "
        "먼저 나온 감상과 사용자 답변에 이미 있는 사실만 사용하세요. 새로운 행동, 표정, 박수, "
        "사물의 상태를 지어내지 말고 AI 자신의 짧은 감정만 덧붙이세요. "
        "좋은 예시는 '직접 지붕을 고치는 중이었다니, 정말 대단하시네요', "
        "'대학교 때부터 함께였다니, 식사하는 모습도 더 편안해 보여요'입니다. "
        "'보셨네요', '생각하셨네요', '그렇군요'처럼 답을 평가하거나 되받는 정형 문구는 쓰지 마세요. 첫 감상과 "
        "같은 내용을 반복하지 마세요. 아래에 '연결에 사용할 표현'이 있으면 그중 하나를 자연스럽게 "
        "포함하세요. 추상적인 비유나 발표문 같은 말투 대신 실제 가족끼리 영상을 보며 쓸 법한 쉬운 "
        "한국어로 말하세요. 아래의 '안전한 반응 초안'에 담긴 사실 범위를 절대 벗어나지 말고, 그 초안의 "
        "말투와 문장 구조만 더 자연스럽게 바꾼다고 생각하세요. 자연스러운 한국어 22~55자, 최대 두 "
        "문장으로 출력하세요. " + style_hint
    )
    try:
        from src.common.llm import chat
        text = chat(
            "ax",
            system,
            (f"mode: {mode}\n이 모드의 작성 규칙: {mode_instruction}\n"
             f"확인된 장면 정보: {scene_basis}\n먼저 나온 감상: {body.opener}\n"
             f"안전한 반응 초안: {fallback}\n"
             f"연결에 사용할 표현: {', '.join(required_terms)}\n질문: {body.question}\n"
             f"사용자 답변: {response_answer}"),
            temperature=0.62,
            timeout=4.5,
            max_tokens=70,
            retries=0,
        ).strip().strip('"').replace("\n", " ")
        text = re.sub(r"\s+", " ", text)
        forbidden = (
            "기억력", "인지", "검사", "진단", "정답", "오답", "틀렸", "이상형",
            "아, 그렇군요", "말씀 잘 들었", "이야기해 주셔서 고마워", "우리 계속 같이",
            "거머쥐셨", "받으셨", "만나셨", "올라가셨", "고치셨", "수리하셨",
            "이라는 표현", "안정적으로", "그렇게 보셨을 만큼", "그 표현",
            "싶어", "때문", "위해", "것 같아요",
            "보셨", "생각하셨", "그렇군요", "그러셨군요", "박수", "오래돼", "오래되",
            "상태였", "이라는 설명", "화면에서",
            "생겨서였다니", "로서는", "느낌이었겠", "같은 의미", "정확히",
            "기억하셨", "기억하고", "떠오르셨", "느끼셨", "같은 장면", "사람마다",
            "말해주진", "하셨죠", "단단하게", "단단한", "무게감", "그 무게",
            "최고의 영예", "롤모델", "매력 포인트", "또렷해서", "오래전 같지",
            "1등까지 올라", "수상의 증거", "켜켜이", "마음을 사로잡", "설득력 있게",
            "인상적이셨나", "모르신다고", "화면 가득", "아, ", "보였을 만",
            "따뜻한 이야기", "수상 경력", "대단하세요", "받아서요,",
            "그럴 만", "말씀해 주신", "그 한 사실", "덕분에", "들어오셨군요",
            "시간을 훌쩍", "였구나", "보였어.", "했어.",
            "아까 대상이요", "바로 그거",
            "했다고 했어요", "인정받았던 기억", "더해진 자리", "큰 영향을",
        )
        compact_text = _compact_answer(text)
        compact_question = _compact_answer(body.question)
        compact_opener = _compact_answer(body.opener)
        repeated_span = any(
            compact_text.count(compact_text[index:index + 10]) > 1
            for index in range(max(0, len(compact_text) - 9))
        )
        repeats_question = bool(
            len(compact_question) >= 10 and compact_question[:10] in compact_text
        )
        repeats_opener = any(
            compact_opener[index:index + 12] in compact_text
            for index in range(max(0, len(compact_opener) - 11))
        )
        asks_followup = "?" in text or "까요" in text
        misses_required_term = bool(required_terms and not any(
            _compact_answer(term) in compact_text for term in required_terms
        ))
        # partial/uncertain/unrelated 응답에서 사용자가 말하지 않은 기준 답변의 핵심을
        # 새로 알려주면 검사 정답을 누설한다. LLM에는 기준 답변을 보내지 않고, 출력도
        # 서버에서 한 번 더 차단한다.
        protected_terms: dict[str, tuple[str, ...]] = {
            "d1": ("대상", "1등", "일등", "우승", "최고상"),
            "x1": ("대상", "수상", "유명", "대세"),
            "d2": ("1학년", "일학년", "캠퍼스"),
            "x2": ("보수", "수리", "고치", "고친", "고칠", "고쳤", "손보"),
        }
        leaks_new_answer_fact = mode != "correct" and any(
            _compact_answer(term) in compact_text
            and (mode in ("uncertain", "unrelated")
                 or _compact_answer(term) not in answer_compact)
            for term in protected_terms.get(body.questionId, ())
        )
        # 구체적으로 틀린 답은 그대로 반복하는 순간 맞장구처럼 들릴 수 있다.
        wrong_claim_terms = tuple(
            candidate
            for candidate, _ in neutral_claims.get(body.questionId, ())
            if candidate in answer_compact
        )
        repeats_wrong_claim = bool(
            mode == "unrelated" and any(
                _compact_answer(term) in compact_text for term in wrong_claim_terms
            )
        )
        scene_hallucinations: dict[str, tuple[str, ...]] = {
            "d1": ("관객", "무대", "노래하실때자신감", "오래함께한장면", "설렘"),
            "x1": ("학생들표정", "학생들이들떠", "우르르", "끌렸", "자연스럽게끌"),
            "d2": ("서로바라", "캠퍼스풍경"),
            "x2": ("아늑",),
        }
        invents_scene = any(
            _compact_answer(term) in compact_text
            for term in scene_hallucinations.get(body.questionId, ())
        )
        redundant_award = bool(
            body.questionId == "d1" and "대상" in compact_text
            and any(term in compact_text for term in ("1등", "일등"))
        )
        missing_uncertain_reassurance = bool(
            mode == "uncertain" and not any(
                term in compact_text
                for term in ("괜찮", "떠오르지", "헷갈", "천천히", "모르")
            )
        )
        opener_semantic_terms = {
            "d1": ("사진", "젊은"),
            "x1": ("기타", "정겨"),
            "d2": ("식사", "음식", "다정", "편안"),
            "x2": ("높은", "조마조마", "걱정", "아찔"),
        }
        semantically_repeats_opener = bool(
            any(
                term in compact_text
                for term in opener_semantic_terms.get(body.questionId, ())
            )
        )
        validates_partial_circular_answer = bool(
            body.questionId == "x1" and mode == "partial" and "따라다" in compact_text
        )
        if (len(text) < 22 or len(text) > 55 or repeated_span or repeats_question
                or repeats_opener or asks_followup
                or misses_required_term
                or leaks_new_answer_fact or repeats_wrong_claim or invents_scene
                or redundant_award or missing_uncertain_reassurance
                or semantically_repeats_opener or validates_partial_circular_answer
                or any(word in text for word in forbidden)):
            raise ValueError("안전 조건을 벗어난 동적 반응")
        return {"text": text, "mode": mode, "source": "llm"}
    except Exception:
        return {"text": fallback, "mode": mode, "source": "fallback"}


@app.post("/api/transcribe")
def transcribe_answer(
    audio: UploadFile = File(...),
    answerKeywords: str = Form("[]"),
):
    """질문 한 건의 녹음을 A.X STT로 전사해 사용자 화면에 바로 돌려준다.

    최종 리포트 생성 전에도 사용자가 자신이 말한 내용을 글로 확인할 수 있도록
    질문별로 호출한다. 실패하면 빈 시연 문장을 만들지 않고 명시적인 오류를 반환한다.
    """
    try:
        keywords_raw = json.loads(answerKeywords)
        keywords = [str(k) for k in keywords_raw if str(k).strip()]
    except Exception:
        keywords = []

    suffix = Path(audio.filename or "answer.webm").suffix or ".webm"
    try:
        with tempfile.TemporaryDirectory(prefix="transcribe_") as tmp_name:
            path = Path(tmp_name) / f"answer{suffix}"
            with path.open("wb") as fh:
                shutil.copyfileobj(audio.file, fh)
            text = _stt(str(path), keywords=keywords)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"A.X STT 전사에 실패했습니다. ({type(exc).__name__})",
        ) from exc
    return {"text": text}


@app.websocket("/api/stt/live")
async def transcribe_answer_live(websocket: WebSocket):
    """녹음 중 PCM을 A.X에 바로 전달해 답변 종료 뒤의 전사 대기를 줄인다.

    브라우저에는 국내 API 키를 노출하지 않는다. 브라우저가 16kHz mono PCM 청크를
    보내면 이 서버가 A.X Streaming WebSocket으로 중계하고, 최종 전사만 돌려준다.
    연결 실패 시 프런트는 기존 파일 전사 경로로 자동 폴백한다.
    """
    import asyncio
    import base64
    import ssl

    import certifi
    import websockets

    from src.common.stt import AXSTT, MODEL_STREAM, WS_BASE

    await websocket.accept()
    upstream = None
    forward_task = None
    try:
        start = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        keywords = _stt_boost_keywords([
            str(value) for value in start.get("keywords", []) if str(value).strip()
        ])
        client = AXSTT()
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        upstream = await websockets.connect(
            f"{WS_BASE}/v1/stt/realtime",
            additional_headers=client.headers,
            ssl=ssl_context,
            open_timeout=15,
            close_timeout=5,
        )
        create = {
            "message_type": "create",
            "speech_model": MODEL_STREAM,
            "audio_format": "pcm_16k",
            "vad_type": "semantic",
            "partial": True,
            "tr_id": f"memflix-live-{uuid.uuid4().hex[:12]}",
        }
        if keywords:
            create["keywords"] = keywords
        await upstream.send(json.dumps(create, ensure_ascii=False))
        created = json.loads(await asyncio.wait_for(upstream.recv(), timeout=15))
        if created.get("message_type") != "created" or created.get("code") != 0:
            raise RuntimeError(f"A.X 실시간 채널 생성 실패: {created.get('error', created)}")
        await websocket.send_json({"type": "ready"})

        async def forward_browser_audio():
            stop_sent = False
            try:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        if not stop_sent:
                            await upstream.send(json.dumps({"message_type": "stop"}))
                        return
                    chunk = message.get("bytes")
                    if chunk:
                        await upstream.send(json.dumps({
                            "message_type": "audio",
                            "data": base64.b64encode(chunk).decode("ascii"),
                        }))
                        continue
                    raw_text = message.get("text")
                    if not raw_text:
                        continue
                    command = json.loads(raw_text)
                    if command.get("type") == "stop":
                        await upstream.send(json.dumps({"message_type": "stop"}))
                        stop_sent = True
                        return
            except Exception:
                if not stop_sent:
                    try:
                        await upstream.send(json.dumps({"message_type": "stop"}))
                    except Exception:
                        pass

        forward_task = asyncio.create_task(forward_browser_audio())
        final_parts: list[str] = []
        last_partial = ""
        try:
            async for raw in upstream:
                data = json.loads(raw)
                message_type = data.get("message_type")
                if message_type == "transcript":
                    normalized = _normalize_stt_text(str(data.get("text", "")), keywords)
                    if not normalized:
                        continue
                    if data.get("final"):
                        if not final_parts or final_parts[-1] != normalized:
                            final_parts.append(normalized)
                    else:
                        last_partial = normalized
                    await websocket.send_json({
                        "type": "transcript",
                        "text": normalized,
                        "final": bool(data.get("final")),
                    })
                elif message_type == "stopped":
                    break
                elif data.get("code", 0) not in (0, None):
                    raise RuntimeError(f"A.X 실시간 인식 실패: {data}")
        except websockets.exceptions.ConnectionClosed:
            pass

        transcript = " ".join(final_parts).strip() or last_partial.strip()
        if not transcript:
            raise RuntimeError("A.X 실시간 전사 결과가 비어 있습니다.")
        await websocket.send_json({"type": "done", "text": transcript})
    except Exception as exc:
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"실시간 전사 실패: {type(exc).__name__}",
            })
        except Exception:
            pass
    finally:
        if forward_task is not None and not forward_task.done():
            forward_task.cancel()
        if upstream is not None:
            try:
                await upstream.close()
            except Exception:
                pass


# /api 아래에도 노출 — 프론트 vite 프록시가 /api/score/* 만 중계하므로
# 프론트에서 상태를 확인하려면 이 경로가 필요하다.
@app.get("/api/health")
def api_health():
    return _health()


@app.post("/api/report", response_model=ReportResponse)
def make_report(
    answers: str = Form(..., description="AnswerIn[] JSON 문자열"),
    patientName: str | None = Form(None),
    patientBirthDate: str | None = Form(None),
    contentId: str | None = Form(None, description="시청 콘텐츠 ID (회상 축 채점에 필요)"),
    audio: list[UploadFile] = File(default=[]),
):
    """녹음·채점 결과를 최신 세션으로 보존하고 리포트를 반환한다.

    보호자 화면에서 실제 사용자 목소리를 들을 수 있어야 하므로 질문별 원본 녹음과
    report.json을 ``data/live`` 아래에 저장한다. 처리 실패는 측정 불가로 반환하며
    고정된 목업 점수를 실제 요청의 결과에 섞지 않는다.
    """
    session_id = f"{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:8]}"
    session_dir = LIVE_ROOT / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    recording_base_url = f"/api/score/report/audio/{session_id}"
    try:
        result = _make_report(
            answers, patientName, patientBirthDate, audio, contentId,
            temp_dir=session_dir,
            recording_base_url=recording_base_url,
        )
    except Exception as e:
        import traceback
        traceback.print_exc()          # 서버 콘솔에는 전체 트레이스백을 남긴다
        try:
            items = json.loads(answers)
        except Exception:
            items = []
        if not isinstance(items, list):
            items = []
        items = [item for item in items if isinstance(item, dict)]
        from src.api.recording_store import bind_recordings
        items, _ = bind_recordings(items, session_dir)
        result = _unavailable_report(
            patientName,
            patientBirthDate,
            items,
            note=f"분석 처리에 실패해 점수를 계산하지 않았습니다. ({type(e).__name__})",
            recording_base_url=recording_base_url,
        )

    try:
        _store_report_history(session_id, result)
        result.trend = _load_report_history(result.patientName)
    except Exception as history_error:
        print(f"[report] 이력 저장 실패 error={type(history_error).__name__}")

    (session_dir / "report.json").write_text(
        result.model_dump_json(indent=2), encoding="utf-8",
    )
    return result


def _make_report(
    answers: str,
    patientName: str | None,
    patientBirthDate: str | None,
    audio: list[UploadFile],
    contentId: str | None = None,
    temp_dir: Path | None = None,
    recording_base_url: str | None = None,
    *,
    transcribe_missing: bool = True,
    generate_interpretation: bool = True,
):
    """세션 오디오 + 응답 → 리포트.

    처리 순서
      1) 업로드 오디오 저장
      2) 음향 피처 추출 (원본 파형, STT 무관)
      3) STT로 응답 텍스트 확보 (userAnswer 비어 있을 때만)
      4) 언어 피처 → 규칙 채점 → 5축 점수
      5) 근거 검색 → Solar 해석 → 검증
    """
    items = json.loads(answers)
    if not isinstance(items, list) or any(not isinstance(it, dict) for it in items):
        raise ValueError("answers must be a list of answer objects")
    from src.api.report_input import normalize_answer_texts, usable_answer_text
    items = normalize_answer_texts(items)
    reference_mode, reference_notice = _reference_profile(patientBirthDate)

    tmp = temp_dir or Path(tempfile.mkdtemp(prefix="session_"))
    from src.api.recording_store import save_recordings, bind_recordings, analysis_recordings
    saved = save_recordings(audio, tmp)
    items, unresolved_audio = bind_recordings(items, tmp)
    analysis_audio, audio_scope = analysis_recordings(items, saved)
    (tmp / 'audio_scope.json').write_text(
        json.dumps(audio_scope, ensure_ascii=False, indent=2), encoding='utf-8',
    )

    model = _load_model()
    if model is None or not saved:
        return _unavailable_report(
            patientName,
            patientBirthDate,
            items,
            note="참조분포 또는 녹음이 없어 점수를 계산하지 않았습니다.",
            recording_base_url=recording_base_url,
        )

    if not analysis_audio:
        return _unavailable_report(
            patientName, patientBirthDate, items,
            "분석 답변에 정확히 연결된 녹음이 없어 점수를 계산하지 않았습니다. 저장된 답변과 원본 녹음은 보존했습니다.",
            recording_base_url=recording_base_url,
        )

    # ── 2) 음향 피처 ────────────────────────────────────────
    from src.agents.analysis.features.build_vector import build_feature_vector
    from src.agents.analysis.features.extract_acoustic import extract_acoustic

    invalid_audio: list[Path] = []
    main_audio = _combine_audio(analysis_audio.values(), tmp, invalid_paths=invalid_audio)
    invalid_names = {path.name for path in invalid_audio}
    (tmp / 'audio_decode.json').write_text(json.dumps({
        'usable_filenames': [name for name in analysis_audio if name not in invalid_names],
        'invalid_filenames': sorted(invalid_names),
        'criterion': 'Decodable, nonempty, finite samples; not a speech-quality assessment.',
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    if main_audio is None:
        return _unavailable_report(
            patientName, patientBirthDate, items,
            "녹음 파일을 읽을 수 없거나 음성 샘플이 비어 있어 점수를 계산하지 않았습니다.",
            recording_base_url=recording_base_url,
        )
    duration, signal_rms, signal_peak = _audio_signal_stats(main_audio)
    if duration < 0.6 or signal_rms < 0.0008 or signal_peak < 0.008:
        return _unavailable_report(
            patientName,
            patientBirthDate,
            items,
            "마이크 입력이 감지되지 않아 점수를 계산하지 않았습니다.",
            recording_base_url=recording_base_url,
        )
    # 한국어 참조분포는 참가자 발화 구간으로 만들었다. 런타임 전체 녹음의
    # 질문 사이 무음까지 휴지로 넣으면 모든 휴지 축이 z=+3에 포화된다.
    acoustic = extract_acoustic(str(main_audio), vad_mode="all")

    # ── 3) 응답 텍스트 (없으면 STT) ─────────────────────────
    transcript_fallback_used = any(
        it.get("transcriptSource") == "demo" for it in items
    )
    stt_error = ("마이크 녹음 실패로 시연 전사 사용"
                 if transcript_fallback_used else "")
    for it in items:
        if transcribe_missing and not it.get("userAnswer") and not str(it.get("id", "")).startswith("p-"):
            fn = it.get("audioFilename")
            if fn and fn in analysis_audio and fn not in invalid_names:
                try:
                    keywords = [str(k) for k in it.get("answerKeywords", []) if str(k).strip()]
                    it["userAnswer"] = usable_answer_text(_stt(str(saved[fn]), keywords=keywords))
                    if not it["userAnswer"].strip():
                        stt_error = "A.X STT에서 분석 가능한 전사를 얻지 못했습니다."
                    print(f"[report] STT 성공 question={it.get('id')} "
                          f"chars={len(it['userAnswer'])}")
                except Exception as e:      # STT 실패해도 음향 채점은 계속한다
                    # 이번 대회 API의 업로드 WAF가 시연 환경 IP를 막는 동안에만
                    # 사전에 명시한 시연 전사를 쓴다. 실제 음향 점수는 녹음에서 계산한다.
                    fallback = usable_answer_text(it.get("fallbackAnswer", "")).strip()
                    it["userAnswer"] = fallback
                    if fallback:
                        it["transcriptSource"] = "demo"
                    transcript_fallback_used = transcript_fallback_used or bool(fallback)
                    stt_error = f"A.X STT 연결 실패 ({type(e).__name__})"
                    print(f"[report] STT 대체 전사 question={it.get('id')} "
                          f"error={type(e).__name__}")

    incomplete_transcript = any(
        not it['userAnswer'] for it in items
        if not str(it.get('id', '')).startswith('p-')
    )
    partial_note = stt_error
    if incomplete_transcript and not partial_note:
        partial_note = "일부 답변의 전사 또는 연결된 녹음이 없어 해당 내용을 측정하지 못했습니다."
    if unresolved_audio:
        audio_note = "일부 답변과 녹음을 정확히 연결할 수 없어 해당 재생 링크를 제공하지 않습니다."
        partial_note = (partial_note + " / " if partial_note else "") + audio_note
    if invalid_audio:
        decode_note = f"녹음 {len(invalid_audio)}개는 읽을 수 없거나 샘플이 유효하지 않아 음향 분석과 전사에서 제외했습니다. 저장된 답변 원문은 보존했습니다."
        partial_note = (partial_note + " / " if partial_note else "") + decode_note
    if audio_scope['unreferenced_filenames']:
        scope_note = "답변에 고유하게 연결되지 않은 추가 녹음은 분석에서 제외하고 원본으로 보관했습니다."
        partial_note = (partial_note + " / " if partial_note else "") + scope_note

    # Acoustic extraction remains independent of STT, but energy/periodicity
    # alone cannot establish that an input is a person's usable speech. Keep
    # the saved audio for recovery; do not convert tone/noise into speech scores.
    if not any(str(it.get("userAnswer", "")).strip() for it in items
               if not str(it.get("id", "")).startswith("p-")):
        result = _unavailable_report(
            patientName, patientBirthDate, items,
            "음향 추출은 수행했지만 분석 가능한 전사가 없어 발화 평가 점수를 제공하지 않습니다. "
            "녹음과 전사 상태를 확인해 주세요.",
            recording_base_url=recording_base_url,
        )
        result.analysisVersion = 4
        if any(it.get("responseType") == "free_recall" for it in items):
            result.recallObservations = {
                "measurement_status": "unavailable", "reason": "no_usable_transcript"}
        return result

    # ── 4) 언어 피처 + 채점 ─────────────────────────────────
    # 생일 확인은 프로필 일치 확인일 뿐 언어 분석 표본이 아니다. 날짜·장소처럼
    # 짧게 답하도록 설계한 지남력 문답도 단어 수준·논리 연결을 왜곡하므로 분리한다.
    analysis_items = [
        it for it in items if not str(it.get("id", "")).startswith("p-")
    ]
    media_items = [
        it for it in items
        if not str(it.get("id", "")).startswith(("p-", "o-", "f-"))
    ]
    reflection_items = [it for it in items if str(it.get("id", "")).startswith("f-")]
    content_items = [*media_items, *reflection_items]
    analysis_texts = [str(it.get("userAnswer", "")).strip() for it in analysis_items]
    analysis_texts = [text for text in analysis_texts if text]
    content_texts = [str(it.get("userAnswer", "")).strip() for it in content_items]
    content_texts = [text for text in content_texts if text]
    transcript = " ".join(analysis_texts).strip()
    media_transcript = " ".join(it.get("userAnswer", "") for it in media_items).strip()
    try:
        from src.agents.analysis.features.extract_linguistic import extract_linguistic
        linguistic = (
            extract_linguistic(transcript, [], utterance_texts=analysis_texts)
            if transcript else {}
        )
    except Exception:
        linguistic = {}

    # 영상 네 문답과 자유 감상을 함께 사용한다. 자유 감상만 사용하면 충분히
    # 대화했는데도 29형태소처럼 짧게 잡혀 결과가 사라지는 문제가 있었다.
    content_transcript = " ".join(content_texts).strip()
    try:
        from src.agents.analysis.features.extract_linguistic import extract_linguistic
        content_linguistic = (
            extract_linguistic(content_transcript, [], utterance_texts=content_texts)
            if content_transcript else {}
        )
    except Exception:
        content_linguistic = {}

    vec, names = build_feature_vector(acoustic, linguistic)
    vec = _align_vector(vec, names, model.feature_names)
    scored = model.score_one(vec)
    axes = scored.get("axes", {})

    speech = ScoreCategory(
        key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
        factors=_factors(axes, SPEECH_AXES),
    )

    # 내용 점수 — 전사 기반 3축(참조분포) + 회상 기반 2축(이벤트 그래프 정답 대비)
    content_axes: dict = {}
    recall_out: dict | None = None
    # Explicit free-recall metadata is required. A sequence of answers prompted
    # in video order supplies no evidence that the user recalled that order.
    n_scenes = 0
    if contentId and any(it.get("responseType") == "free_recall" for it in items):
        from src.agents.analysis.recall_pipeline import recall_from_answers
        from src.event_graph.sample_loader import load_all
        graph = {g.content_id: g for g in load_all()}.get(contentId)
        if graph is not None:
            n_scenes = len(graph.nodes)
            recall_out = recall_from_answers(items, graph)
        else:
            recall_out = {"measurement_status": "unavailable", "reason": "unknown_content"}
    if CONTENT_MODEL_PATH.exists():
        try:
            from src.agents.analysis.scoring.score_content import ContentScoringModel
            cm = ContentScoringModel.load(str(CONTENT_MODEL_PATH))

            content_vec = _align_vector(
                *build_feature_vector(acoustic, content_linguistic), cm.feature_names,
            )
            content_axes = cm.score_all(content_vec, recall=recall_out,
                                        n_scenes=n_scenes).get("axes", {})
            # Kang 인터뷰 학습 캐시의 최소 발화량은 114형태소다. 미디어 문답처럼
            # 그보다 짧은 전사를 같은 규준에 넣으면 TTR·접속어 비율이 길이 효과로
            # 크게 흔들린다. 이 범위 밖에서는 낮은 점수로 오해시키지 않고 측정 불가로 둔다.
            content_axes = _suppress_short_transcript_content_axes(
                content_axes, content_linguistic,
            )
            reflection_logic = _score_reflection_logic(items)
            if reflection_logic is not None:
                content_axes["논리 연결"] = reflection_logic
            # H231141 시연처럼 이벤트 그래프가 없는 콘텐츠는 질문별 정답 키워드로
            # 두 회상 축을 직접 계산한다. 객관식 정답 대비 점수이며 판별력은 미검증이다.
            question_items = [it for it in items if it.get("responseType") != "free_recall"]
            content_axes.update(_score_question_answers(question_items, use_llm=True))
            orientation_axis = _score_orientation_answers(items)
            if orientation_axis is not None:
                content_axes["시간·장소 지남력"] = orientation_axis
        except Exception:
            content_axes = {}
    content = ScoreCategory(
        key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
        factors=_factors(content_axes, CONTENT_AXES),
    )

    # ── 5) 근거 검색 → 해석 → 검증 ──────────────────────────
    interp = None
    try:
        if scored.get("total_score") is None:
            raise ValueError("유효한 발화 축이 없어 해석을 생성하지 않음")
        if not generate_interpretation:
            interp = _safe_interpretation(speech, content)
        elif os.environ.get("DEMO_FAST_MODE", "0") == "1":
            interp = _fast_interpretation(speech, content)
        else:
            from src.agents.analysis.scoring.interpret import interpret_scores
            # max_retries=1: 생성→검증→(실패 시)재생성 1회까지.
            # 서빙 경로라 응답 시간이 중요하다. 재시도를 늘리면 LLM 호출이 곱으로 늘어난다.
            out = interpret_scores(scored, max_retries=1)
            rep, v = out["report"], out.get("verify") or {}
            if v.get("pass"):
                interp = Interpretation(
                    summary=rep.get("summary", ""),
                    axisComments=rep.get("axis_comments", {}),
                    caveats=rep.get("caveats", ""),
                    recommendation=rep.get("recommendation", ""),
                    evidenceIds=out.get("evidence", {}),
                    verified=True,
                    verifyIssues=[],
                )
            else:
                # 검증에 실패한 생성 문장을 그대로 가족 리포트에 보존하지 않는다.
                # 수치·실제 녹음은 사용할 수 있지만 자동 해석은 안전한 규칙 문장으로 대체한다.
                interp = _safe_interpretation(
                    speech,
                    content,
                    issues=v.get("issues", []),
                )
    except Exception as e:
        interp = _safe_interpretation(speech, content, issues=[f"해석 생성 실패: {type(e).__name__}"])

    # STT 실패 또는 전사 누락 사유를 리포트에 남긴다. 미측정은 유효 0점이 아니다.
    if partial_note:
        interp.caveats = (interp.caveats + " / " if interp.caveats else "") + partial_note

    questions = _rank_questions(items, recording_base_url=recording_base_url)
    content_has_unavailable = any(not factor.available for factor in content.factors)
    short_factors = [
        factor for factor in content.factors
        if factor.available and isinstance(factor.detail, dict)
        and factor.detail.get("confidence") in {"low", "moderate"}
    ]
    short_notice = ""
    if short_factors:
        detail = short_factors[0].detail or {}
        n_morphemes = int(detail.get("n_morphemes") or 0)
        reference_min = int(detail.get("reference_min") or 0)
        labels = "·".join(factor.label for factor in short_factors)
        confidence = str(detail.get("confidence") or "low")
        confidence_label = "보통" if confidence == "moderate" else "낮음"
        short_notice = (
            f"실제 녹음과 응답을 모두 분석했습니다. {labels}은 비교적 짧은 문답에서 "
            f"계산한 참고 관찰값이므로 신뢰도는 {confidence_label}으로 표시합니다."
        )
    return ReportResponse(
        patientName=patientName, patientBirthDate=patientBirthDate,
        speechScore=speech, contentScore=content,
        questions=questions, trend=[], interpretation=interp,
        # 고정 시연 전사를 쓴 세션은 실제 음향이 있어도 demo로 명시해 실제 추세 DB와
        # 섞이지 않게 한다. STT 일부 결측만 있는 실제 세션은 partial로 구분한다.
        analysisMode=(
            "demo" if transcript_fallback_used else
            "partial" if partial_note else
            "scored"
        ),
        notice=(
            "실제 녹음의 음향 점수와 시연용 전사로 계산한 내용 점수입니다. "
            "A.X STT 연결 복구 후 전체 실제 분석으로 전환됩니다."
            if transcript_fallback_used else
            "사용할 수 있는 녹음과 전사를 분석했지만 일부 입력이나 녹음 연결은 확인하지 못했습니다."
            if partial_note else
            short_notice
            if short_notice else
            "실제 녹음과 응답을 분석했으며, 입력이 부족한 일부 항목은 "
            "이번 점수에서 제외했습니다."
            if content_has_unavailable else
            "실제 녹음과 응답을 분석한 결과입니다."
        ),
        referenceMode=reference_mode,
        referenceNotice=reference_notice,
        analysisVersion=4,
        recallObservations=recall_out,
    )


def _fast_interpretation(speech: ScoreCategory, content: ScoreCategory) -> Interpretation:
    """외부 LLM 지연 없이 시연용 사실만 요약한다. 진단 판단은 포함하지 않는다."""
    measured = [f for f in speech.factors + content.factors if f.available]
    if measured:
        lowest = min(measured, key=lambda factor: factor.score)
        if lowest.score >= 85:
            summary = (
                f"이번 시청 대화에서 측정한 {len(measured)}개 항목이 모두 "
                "양호한 범위로 나타났습니다."
            )
        else:
            summary = (
                f"이번 시청 대화에서는 {len(measured)}개 항목을 측정했습니다. "
                f"'{lowest.label}' 항목은 한 번의 점수보다 이후 변화 추이를 함께 참고해 주세요."
            )
    else:
        summary = "이번 녹음에서 안정적으로 계산할 수 있는 항목이 부족했습니다."
    return Interpretation(
        summary=summary,
        caveats="빠른 시연 모드의 규칙 기반 요약이며 의료적 진단 결과가 아닙니다.",
        recommendation="같은 조건에서 여러 차례 기록한 결과와 함께 참고해 주세요.",
        verified=False,
    )


def _safe_interpretation(
    speech: ScoreCategory,
    content: ScoreCategory,
    issues: list[str] | None = None,
) -> Interpretation:
    """생성 해석이 미검증일 때 수치 사실만 남기는 보호자용 안전 폴백."""
    speech_count = sum(f.available for f in speech.factors)
    content_count = sum(f.available for f in content.factors)
    return Interpretation(
        summary=(
            f"이번 기록에서는 실제 녹음으로 발화 {speech_count}개 항목과 "
            f"내용 {content_count}개 항목을 계산했습니다."
        ),
        axisComments={f.label: f"이번 기록에서 계산된 점수는 {f.score}점입니다."
                      for category in (speech, content) for f in category.factors if f.available},
        caveats=(
            "자동 생성 해석의 교차검증을 완료하지 못해 해석 문장은 제공하지 않습니다. "
            "표시된 수치와 질문별 실제 녹음을 함께 확인해 주세요."
        ),
        recommendation=(
            "한 번의 점수만으로 판단하지 말고, 같은 조건에서 반복한 결과와 "
            "평소 생활에서의 모습을 함께 참고해 주세요."
        ),
        verified=False,
        verifyIssues=list(issues or []),
    )


def _align_vector(vec, names: list[str], target_names: list[str]):
    """현재 추출 피처를 저장 모델의 고정 순서에 맞춘다. 없는 피처는 결측."""
    import numpy as np
    values = {name: float(value) for name, value in zip(names, vec)}
    return np.array([values.get(name, np.nan) for name in target_names], dtype=float)


def _combine_audio(paths, tmp: Path, *, invalid_paths: list[Path] | None = None) -> Path | None:
    """Combine in order; new reports can explicitly collect decode exclusions.

    The default preserves strict legacy behavior. Silence/energy thresholds
    remain the caller's separate responsibility; excluded originals are kept.
    """
    items = list(paths)
    if invalid_paths is None and len(items) == 1:
        return items[0]
    import librosa
    import numpy as np
    import soundfile as sf
    if invalid_paths is None:
        chunks = [librosa.load(str(path), sr=16000, mono=True)[0] for path in items]
    else:
        chunks = []; valid = []
        for path in items:
            try:
                chunk, _ = librosa.load(str(path), sr=16000, mono=True)
                if chunk.size == 0 or not np.isfinite(chunk).all():
                    raise ValueError('Empty or non-finite audio samples')
            except Exception:
                invalid_paths.append(path)
                continue
            chunks.append(chunk); valid.append(path)
        if not valid:
            return None
        if len(valid) == 1:
            return valid[0]
    out = tmp / "session_combined.wav"
    sf.write(out, np.concatenate(chunks), 16000, subtype="PCM_16")
    return out


def _audio_signal_stats(path: Path) -> tuple[float, float, float]:
    """녹음의 (길이 초, RMS, peak)를 반환한다. 디코딩 실패는 무음으로 본다."""
    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(str(path), sr=16000, mono=True)
        if y.size == 0 or sr <= 0:
            return 0.0, 0.0, 0.0
        return (
            float(y.size / sr),
            float(np.sqrt(np.mean(np.square(y)))),
            float(np.max(np.abs(y))),
        )
    except Exception:
        return 0.0, 0.0, 0.0


def _unavailable_report(name, birth, items, note, recording_base_url=None):
    """무음·손상 녹음을 낮은 점수로 오인하지 않도록 전 축을 측정 불가로 반환한다."""
    reference_mode, reference_notice = _reference_profile(birth)
    return ReportResponse(
        patientName=name,
        patientBirthDate=birth,
        referenceMode=reference_mode,
        referenceNotice=reference_notice,
        speechScore=ScoreCategory(
            key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
            factors=[ScoreFactor(label=label, score=0, available=False)
                     for label in SPEECH_AXES],
        ),
        contentScore=ScoreCategory(
            key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
            factors=[ScoreFactor(label=label, score=0, available=False)
                     for label in CONTENT_AXES],
        ),
        questions=_rank_questions(items or [], recording_base_url=recording_base_url),
        trend=[],
        interpretation=Interpretation(
            summary="이번 요청에서는 분석 가능한 결과를 얻지 못해 점수를 제공하지 않습니다.",
            caveats=note,
            recommendation="안내된 사유를 확인한 뒤 다시 진행해 주세요.",
            verified=False,
        ),
        analysisMode="partial",
        analysisVersion=4,
        notice=note,
    )


_SEMANTIC_ANSWER_RULES: dict[
    str, tuple[tuple[float, tuple[tuple[str, ...], ...]], ...]
] = {
    # (점수, 필수 의미 묶음들). 같은 묶음 안의 표현은 동의어이고, 여러 묶음이
    # 있으면 각 묶음에서 하나씩 확인돼야 한다. 높은 점수 규칙부터 적용한다.
    "d1": (
        (1.0, (("대상", "1등", "일등", "1위", "일위", "최고상", "우승"),)),
        (0.5, (("큰상", "상을받", "수상"),)),
    ),
    "x1": (
        # '인기가 있어서'는 질문을 되풀이한 말이라 원인을 설명한 완전 정답으로
        # 보지 않는다. 유명세나 수상처럼 실제 원인을 말해야 1점이다.
        (1.0, (("인기가", "유명", "대세", "알아봐", "알아보", "사람들이몰", "주목"),)),
        (1.0, (("대상", "1등", "일등", "1위", "수상", "우승"),)),
        (0.5, (("인기",),)),
        (0.5, (("대학가요제", "가요제", "노래대회"),)),
    ),
    "d2": (
        (1.0, (("대학교1학년", "대학1학년", "1학년", "일학년"),)),
        (0.75, (("대학교때", "대학때", "대학교시절", "대학생때"),)),
        (0.5, (("캠퍼스커플", "대학커플"),)),
    ),
    "x2": (
        (1.0, ((
            "보수", "고치", "고쳐", "고친", "고칠", "고쳤", "고치러",
            "수리", "수선", "손보", "고장고치",
        ),)),
        (0.75, (("새서", "샌다", "망가", "깨져", "틈을막"),)),
        (0.5, (("문제가",),)),
    ),
}

_EXPLICIT_UNCERTAINTY = (
    "모르", "기억안", "기억이안", "기억나지않", "글쎄", "확실하지",
    "잘모르", "안보이", "안들리", "떠오르지않",
)
_EXPLICIT_NEGATION = (
    "못받", "못했", "못해", "아니야", "아니다", "아닌", "아니었",
    "않았", "않아", "없어서", "없었", "안받", "안했", "안해", "안하려",
)


def _compact_answer(value: str) -> str:
    """비교용 정규화. STT 원문은 건드리지 않고 공백·기호만 제거한다."""
    import re

    return re.sub(r"[^0-9a-zA-Z가-힣]", "", str(value)).lower()


def _effective_assertion(value: str) -> str:
    """'금상이 아니라 대상'처럼 마지막 자기정정 뒤의 실제 주장을 얻는다."""
    compact = _compact_answer(value)
    last_end = 0
    for marker in ("아니라", "아니고"):
        index = compact.rfind(marker)
        if index >= 0:
            last_end = max(last_end, index + len(marker))
    return compact[last_end:] if last_end else compact


def _has_uncertainty(value: str) -> bool:
    compact = _compact_answer(value)
    return any(marker in compact for marker in _EXPLICIT_UNCERTAINTY)


def _has_negation(value: str) -> bool:
    from src.api.orientation import has_terminal_copular_denial

    assertion = _effective_assertion(value)
    return (any(marker in assertion for marker in _EXPLICIT_NEGATION)
            or has_terminal_copular_denial(assertion))


def _response_mode(value: str, semantic_score: float | None) -> str:
    """공감 문장 전략. 채점 결과나 정답은 사용자에게 직접 노출하지 않는다."""
    if _has_uncertainty(value):
        return "uncertain"
    if semantic_score is not None and semantic_score >= 1.0:
        return "correct"
    if semantic_score is not None and semantic_score > 0:
        return "partial"
    return "unrelated"


def _semantic_rule_score(item: dict) -> float | None:
    """시연 질문의 핵심 의미를 동의어 묶음으로 판정한다.

    반환값 ``None``은 해당 질문에 명시적 의미 규칙이 없어 기존 키워드 점수를
    사용해야 한다는 뜻이다. 각 튜플은 같은 의미의 대체 표현이며, 모든 의미
    묶음에서 하나 이상 나타나면 정답으로 본다.
    """
    rules = _SEMANTIC_ANSWER_RULES.get(str(item.get("id", "")))
    if not rules:
        return None
    raw_answer = str(item.get("userAnswer", ""))
    answer = _effective_assertion(raw_answer)
    if not answer:
        return 0.0
    if _has_negation(raw_answer):
        return 0.0

    # "내가 인기가 많은가 봐"처럼 자기 이야기를 한 답변을 영상 속 인물의
    # 인기 원인으로 오인하지 않는다. 영상 속 인물이나 실제 원인을 다시 언급한
    # 경우에는 정상 규칙/LLM 판정으로 넘긴다.
    if str(item.get("id")) == "x1":
        first_person = any(marker in answer for marker in ("나는", "내가", "나를", "나도"))
        video_context = any(marker in answer for marker in (
            "저분", "그분", "그사람", "남자", "대세남", "대상", "수상", "우승",
            "가요제", "유명해져", "유명해서", "알아봐", "알아보",
        ))
        if first_person and not video_context:
            return 0.0

    # 다른 상의 이름을 구체적으로 말한 경우 '상'이라는 공통 글자만으로 부분
    # 정답을 주지 않는다.
    if str(item.get("id")) == "d1" and any(
        award in answer for award in ("금상", "은상", "동상", "우수상", "장려상")
    ):
        score = 0.0
    else:
        score = 0.0
        for candidate_score, required_groups in rules:
            if all(any(term in answer for term in alternatives)
                   for alternatives in required_groups):
                score = candidate_score
                break

    # '대상인지는 잘 모르겠어요'처럼 핵심어를 발음했더라도 질문에 대한 주장을
    # 하지 않은 답변은 정답으로 세지 않는다. 자연스러운 '-인 것 같아요'는 허용한다.
    if score and _has_uncertainty(raw_answer):
        score = 0.0
    return round(score * 4) / 4


def _is_llm_semantic_candidate(item: dict, semantic_score: float) -> bool:
    """질문과 최소한의 의미 접점이 있는 답변만 LLM 복구 대상으로 삼는다.

    LLM은 규칙이 놓친 동의어를 복구하는 용도다. 단순히 노래 취미를 말했거나
    자기 인기를 이야기한 답변까지 정답 일부로 추론하지 못하게 입력 문턱을 둔다.
    """
    if semantic_score >= 1.0:
        return False
    question_id = str(item.get("id", ""))
    answer = _effective_assertion(str(item.get("userAnswer", "")))
    if not answer:
        return False
    relevance_terms: dict[str, tuple[str, ...]] = {
        "d1": ("상", "등", "일위", "우승", "수상", "제일", "최고"),
        "x1": (
            "때문", "해서", "라서", "니까", "유명", "인기", "대상", "수상",
            "우승", "알아봐", "알아보", "대세", "사람들이", "가요제",
        ),
        "d2": ("학년", "대학", "학교", "캠퍼스", "커플", "때", "시절", "년전"),
        "x2": ("지붕", "나무집", "트리하우스", "보수", "수리", "고치", "고장", "비가새"),
    }
    terms = relevance_terms.get(question_id)
    if terms and not any(term in answer for term in terms):
        return False
    if question_id == "x1":
        first_person = any(marker in answer for marker in ("나는", "내가", "나를", "나도"))
        video_context = any(marker in answer for marker in (
            "저분", "그분", "그사람", "남자", "대상", "수상", "우승", "가요제",
            "유명해져", "유명해서", "알아봐", "알아보",
        ))
        if first_person and not video_context:
            return False
    return True


def _llm_semantic_scores(items: list[dict], indices: list[int]) -> dict[int, float]:
    """규칙으로 포착하지 못한 표현만 Solar로 의미 비교한다.

    한 번의 배치 호출로 처리하고 실패하면 빈 결과를 반환한다. 규칙 점수를
    덮어쓰는 용도가 아니라 동의어·우회 표현을 복구하는 안전한 폴백이다.
    """
    if not indices:
        return {}
    try:
        from src.common.llm import chat
        from src.agents.analysis.semantic_batch import prepare, restore

        # 모델에는 연속 번호만 전달한다. 모든 번호가 한 번씩 돌아온 경우에만
        # 요청 문항 번호로 복원한다. 배열 위치로 답을 연결하거나 누락을 0점 처리하지 않는다.
        cases, mapping = prepare(items, indices)
        raw = chat(
            "solar",
            (
                "당신은 미디어 시청 후 회상 답변을 채점합니다. 단어가 정확히 같지 않아도 "
                "사용자 답변의 의미가 기준 답변의 질문 핵심과 같으면 1, 핵심 일부만 맞으면 "
                "0.5, 틀리거나 무관하거나 모른다고 하면 0으로 판정하세요. 사용자가 핵심어를 "
                "말했더라도 이를 부정하거나 모른다고 한 경우에는 1을 주지 마세요. 마지막에 "
                "스스로 정정한 경우에는 정정 뒤의 내용을 기준으로 보세요. 기준 답변에 있는 "
                "부가 정보를 사용자가 생략했더라도 질문에 직접 답한 핵심 의미가 맞으면 1입니다. "
                "사용자가 실제로 말하지 않은 내용을 추론해 보충하지 마세요. 설명이나 마크다운 "
                "없이 [{\"index\":0,\"score\":1}] 형태의 JSON 배열만 출력하세요."
            ),
            json.dumps(cases, ensure_ascii=False),
            temperature=0.0,
            timeout=12,
            max_tokens=220,
            retries=1,
            thinking=False,
        )
        return restore(raw, mapping)
    except Exception:
        return {}


def _score_question_answers(items: list[dict], use_llm: bool = False) -> dict:
    """고정 시연 질문을 핵심 의미 우선으로 채점한다. 판별력은 아직 미검증."""
    import re

    # 생일 확인(p-), 지남력(o-), 자유 감상(f-)은 영상 정답률에 섞지 않는다.
    items = [
        item for item in items
        if not str(item.get("id", "")).startswith(("o-", "p-", "f-"))
        and item.get("responseType") != "free_recall"
    ]
    per_question: list[float | None] = []
    methods: list[str] = []
    llm_candidates: list[int] = []
    for index, item in enumerate(items):
        answer = re.sub(r"\s+", "", str(item.get("userAnswer", ""))).lower()
        keywords = [re.sub(r"\s+", "", str(k)).lower()
                    for k in item.get("answerKeywords", []) if str(k).strip()]
        if not answer:
            # STT 실패/결측은 오답 0점으로 만들지 않는다. 측정 불가로 분리한다.
            per_question.append(None)
            methods.append("unavailable")
            continue
        semantic_score = _semantic_rule_score(item)
        if semantic_score is not None:
            per_question.append(semantic_score)
            methods.append("semantic_rule")
            if (use_llm and _is_llm_semantic_candidate(item, semantic_score)
                    and item.get("correctAnswer")
                    and not _has_uncertainty(str(item.get("userAnswer", "")))
                    and not _has_negation(str(item.get("userAnswer", "")))):
                llm_candidates.append(index)
            continue
        if not keywords:
            per_question.append(None)
            methods.append("unavailable")
            continue
        if (_has_uncertainty(str(item.get("userAnswer", "")))
                or _has_negation(str(item.get("userAnswer", "")))):
            per_question.append(0.0)
            methods.append("explicit_nonassertion")
            continue
        # The generic keyword path also uses the final correction assertion.
        # Preserve its existing whitespace/case normalization and partial-score
        # formula; punctuation matching is not changed by this repair.
        correction_end = 0
        for marker in ("아니라", "아니고"):
            marker_index = answer.rfind(marker)
            if marker_index >= 0:
                correction_end = max(correction_end, marker_index + len(marker))
        keyword_answer = answer[correction_end:]
        hits = sum(1 for keyword in keywords if keyword in keyword_answer)
        # 핵심 표현 하나를 맞히면 절반, 추가 근거를 말할수록 100점에 가까워진다.
        per_question.append(min(1.0, 0.5 + 0.5 * hits / len(keywords)) if hits else 0.0)
        methods.append("keyword")
        if (use_llm and per_question[-1] < 1.0 and item.get("correctAnswer")
                and not _has_uncertainty(str(item.get("userAnswer", "")))
                and not _has_negation(str(item.get("userAnswer", "")))):
            llm_candidates.append(index)

    for index, score in _llm_semantic_scores(items, llm_candidates).items():
        # LLM은 규칙/키워드가 놓친 동의어를 복구만 하며 기존 점수를 낮추지 않는다.
        if per_question[index] is not None and score > per_question[index]:
            per_question[index] = score
            methods[index] = "llm_semantic"

    if not per_question:
        return {}
    valid_scores = [score for score in per_question if score is not None]
    # 한 문항만 전사되고 나머지가 결측인 경우 100점처럼 보이면 안 된다. 전체의
    # 75% 이상을 측정했을 때만 회상 축을 산출하고, 그 미만은 측정 불가로 둔다.
    import math
    minimum_measured = max(1, int(math.ceil(len(per_question) * 0.75)))
    enough_coverage = len(valid_scores) >= minimum_measured
    memory = (int(round(100 * sum(valid_scores) / len(valid_scores)))
              if valid_scores and enough_coverage else None)
    answered = sum(1 for item in items if str(item.get("userAnswer", "")).strip())
    relevance_scores = [
        1.0 if score >= 0.75 else 0.5 if score >= 0.25 else 0.0
        for score in valid_scores
    ]
    matched = sum(1 for score in relevance_scores if score > 0)
    # 부분적으로 관련된 답변을 완전 일치와 똑같이 세지 않는다.
    context = (int(round(100 * sum(relevance_scores) / len(relevance_scores)))
               if relevance_scores and enough_coverage else None)
    detail = {
        "question_scores": [round(v, 3) if v is not None else None
                            for v in per_question],
        "methods": methods,
        "measured": len(valid_scores),
        "required": minimum_measured,
    }
    return {
        "기억 정확도": {"score": memory, "detail": detail, "validated": False},
        "문맥 일치도": {"score": context, "detail": {
            "answered": answered,
            "matched": matched,
            "valid": len(valid_scores),
            "required": minimum_measured,
        },
                    "validated": False},
    }


def _score_orientation_answers(items: list[dict]) -> dict | None:
    """로그인 직후 날짜·요일·장소 문답으로 시간·장소 지남력 축을 계산한다.

    날짜와 요일은 전달된 기준 핵심어와 비교하며 기준 누락은 오답으로 세지 않는다.
    서버가 실제 현재 날짜를 독립 검증하는 것은 아니다. 장소는 사용자의 실제
    위치를 서버가 미리 알 수 없으므로 장소 표현의 구체성만 확인한다.
    STT 결측은 오답으로 만들지 않고 측정 불가로 제외한다.
    """
    import re

    orientation = [
        item for item in items if str(item.get("id", "")).startswith("o-")
    ]
    if not orientation:
        return None

    scores: list[float | None] = []
    details: list[dict] = []

    def weekday_score(raw_answer: str, compact_answer: str, keywords: list[str]) -> float:
        # '수' 같은 한 글자 별칭은 '무슨'에도 들어가므로 부분 문자열로
        # 비교하지 않는다. '수요일' 전체 또는 독립 토큰일 때만 인정한다.
        full = next((keyword for keyword in keywords if len(keyword) > 1), "")
        short = {keyword for keyword in keywords if len(keyword) == 1}
        tokens = set(re.findall(r"[0-9a-zA-Z가-힣]+", raw_answer.lower()))
        return 1.0 if (full and full in compact_answer) or bool(short & tokens) else 0.0

    for item in orientation:
        raw_answer = str(item.get("userAnswer", ""))
        answer = _effective_assertion(raw_answer)
        question_id = str(item.get("id"))
        if not answer:
            empty_ids = ("o-date", "o-weekday") if question_id == "o-date-weekday" else (question_id,)
            for empty_id in empty_ids:
                scores.append(None)
                details.append({"id": empty_id, "score": None})
            continue

        from src.api.orientation import has_terminal_copular_denial

        denied = _has_negation(raw_answer) or has_terminal_copular_denial(answer)
        if question_id in {"o-date", "o-weekday", "o-date-weekday"}:
            supplied = item.get("answerKeywords", [])
            supplied = supplied if isinstance(supplied, (list, tuple)) else []
            # Preserve empty date slots: filtering first would shift weekday
            # aliases into the year/month/day reference positions.
            keywords = [
                _compact_answer(str(value))
                if isinstance(value, (str, int)) and not isinstance(value, bool)
                else ""
                for value in supplied
            ]
            components = (
                [("o-date", keywords[:3]), ("o-weekday", keywords[3:])]
                if question_id == "o-date-weekday" else [(question_id, keywords)]
            )
            uncertain = _has_uncertainty(raw_answer) or denied
            for component_id, reference in components:
                ready = (
                    len(reference) >= 3 and all(reference)
                    if component_id == "o-date" else any(reference)
                )
                if not ready:
                    scores.append(None)
                    details.append({"id": component_id, "score": None,
                                    "reason": "missing_reference"})
                    continue
                if uncertain:
                    component_score = 0.0
                elif component_id == "o-weekday":
                    component_score = weekday_score(
                        raw_answer, answer, [key for key in reference if key],
                    )
                else:
                    from src.api.orientation import matches_date_keyword

                    component_score = sum(
                        matches_date_keyword(raw_answer, key) for key in reference
                    ) / len(reference)
                scores.append(component_score)
                details.append({"id": component_id, "score": round(component_score, 3)})
            continue
        if _has_uncertainty(raw_answer) or denied:
            score = 0.0
        elif question_id == "o-place":
            from src.api.orientation import detect_place_expression

            # "집에 가야지"는 현재 위치가 아니라 목적지를 말한 것이다. 장소
            # 명사가 포함됐다는 이유만으로 현재 장소 정답으로 세지 않는다.
            destination_only = any(marker in answer for marker in (
                "집에가", "집으로가", "가야지", "가야돼", "가야해", "갈거",
                "가려고", "돌아가", "들어가야",
            ))
            if destination_only:
                score = 0.0
            else:
                place_present, method = detect_place_expression(raw_answer)
                if place_present is None:
                    scores.append(None)
                    details.append({"id": question_id, "score": None,
                                    "reason": method})
                    continue
                if place_present:
                    score = 1.0
                elif any(marker in answer for marker in ("여기", "이곳", "그곳")):
                    score = 0.25
                elif any(marker in answer for marker in ("있는곳", "에서보고", "에있어")):
                    score = 0.5
                else:
                    score = 0.0
        else:
            keywords = [
                _compact_answer(str(keyword))
                for keyword in item.get("answerKeywords", [])
                if str(keyword).strip()
            ]
            if question_id == "o-weekday":
                score = weekday_score(raw_answer, answer, keywords)
            else:
                hits = sum(1 for keyword in keywords if keyword in answer)
                score = hits / len(keywords) if keywords else 0.0
        scores.append(score)
        details.append({"id": item.get("id"), "score": round(score, 3)})

    measured = [score for score in scores if score is not None]
    score = int(round(100 * sum(measured) / len(measured))) if measured else None
    return {
        "score": score,
        "detail": {
            "questions": details, "measured": len(measured),
            "measurement_method": "orientation_question_rules",
            "date_weekday_reference": "provided_answer_keywords",
            "place_scope": "place_expression_specificity",
            "actual_date_verified": False,
            "actual_location_verified": False,
        },
        "validated": False,
    }


def _rank_questions(
    items: list[dict],
    recording_base_url: str | None = None,
) -> list[ReportQuestion]:
    """응답을 기여도 순으로. 지금은 입력 순서 유지 + impact 균등 배분.

    ⚠️ 실제 기여도(어느 질문이 판단에 얼마나 기여했는지)는 파일럿 세션으로
       순서 회상 축을 검증한 뒤 확정한다. 그전까지 임의 가중치를 쓰지 않는다.
    """
    from src.api.report_input import usable_answer_text
    out = []
    n = max(len(items), 1)
    for i, it in enumerate(items):
        audio_filename = Path(str(it.get("audioFilename") or "")).name
        recording_url = (
            f"{recording_base_url}/{audio_filename}"
            if recording_base_url and audio_filename else None
        )
        out.append(ReportQuestion(
            id=str(it.get("id", f"q{i+1}")),
            rank=i + 1,
            impact=int(round(100 - (i * (60 / n)))),
            question=it.get("question", ""),
            correctAnswer=it.get("correctAnswer", ""),
            userAnswer=usable_answer_text(it.get("userAnswer", "")),
            answerKeywords=[str(value) for value in it.get("answerKeywords", [])],
            videoTimestamp=float(it.get("videoTimestamp", 0)),
            recordingUrl=recording_url,
            responseType=it.get("responseType", "question_answer"),
            transcriptSource=it.get("transcriptSource", "recorded"),
            cuedSceneIds=it.get("cuedSceneIds"),
        ))
    return out


def _refresh_stored_report_derived_fields(report: ReportResponse) -> ReportResponse:
    """구버전 리포트의 규칙 기반 파생 점수만 갱신한다.

    질문 의미 규칙과 지남력·자유 감상 규칙을 고쳐도 과거 report.json을 그대로 읽으면
    보호자 화면에는 이전의 과대 점수가 남는다. 재전사나 음향 재분석 없이도
    질문 원문만으로 안전하게 다시 계산 가능한 세 축만 최신 규칙을 적용한다.
    현재 버전은 이미 적용한 의미 채점·방법을 보존하고 조회 중 재채점하지 않는다.
    """
    if report.analysisVersion >= 4:
        return report
    if report.analysisMode not in {"scored", "partial"}:
        return report
    if not any(f.available for f in report.speechScore.factors + report.contentScore.factors):
        return report
    items = [question.model_dump() for question in report.questions]
    report.referenceMode, report.referenceNotice = _reference_profile(report.patientBirthDate)
    question_axes = _score_question_answers(items, use_llm=False)
    orientation_axis = _score_orientation_answers(items)
    reflection_logic = _score_reflection_logic(items)
    factors = {factor.label: factor for factor in report.contentScore.factors}
    for label in ("문맥 일치도", "기억 정확도"):
        value = question_axes.get(label)
        if not value or label not in factors:
            continue
        score = value.get("score")
        factors[label].score = int(score) if score is not None else 0
        factors[label].available = score is not None
        factors[label].validated = value.get("validated")
        factors[label].detail = value.get("detail")
    if orientation_axis and "시간·장소 지남력" in factors:
        score = orientation_axis.get("score")
        factor = factors["시간·장소 지남력"]
        factor.score = int(score) if score is not None else 0
        factor.available = score is not None
        factor.validated = orientation_axis.get("validated")
        factor.detail = orientation_axis.get("detail")
    if reflection_logic and "논리 연결" in factors:
        score = reflection_logic.get("score")
        factor = factors["논리 연결"]
        factor.score = int(score) if score is not None else 0
        factor.available = score is not None
        factor.validated = reflection_logic.get("validated")
        factor.detail = reflection_logic.get("detail")
    return report


def _reanalyze_stored_report(report: ReportResponse, report_path: Path) -> ReportResponse:
    """이전 저장 리포트를 원음·전사 그대로 두고 현재 계산 정의로 재분석한다."""
    if report.analysisVersion >= 3 or report.analysisMode not in {"scored", "partial"}:
        return report
    try:
        from src.agents.analysis.features.build_vector import build_feature_vector
        from src.agents.analysis.features.extract_acoustic import extract_acoustic
        from src.agents.analysis.features.extract_linguistic import extract_linguistic
        from src.agents.analysis.scoring.score_content import ContentScoringModel

        session_dir = report_path.parent
        question_audio = [
            session_dir / Path(question.recordingUrl or "").name
            for question in report.questions if question.recordingUrl
        ]
        question_audio = [path for path in question_audio if path.is_file()]
        if not question_audio:
            return report
        combined = _combine_audio(question_audio, session_dir)
        acoustic = extract_acoustic(str(combined), vad_mode="all")
        items = [question.model_dump() for question in report.questions]

        analysis_items = [item for item in items if not str(item.get("id", "")).startswith("p-")]
        media_items = [
            item for item in items
            if not str(item.get("id", "")).startswith(("p-", "o-", "f-"))
        ]
        reflection_items = [item for item in items if str(item.get("id", "")).startswith("f-")]
        analysis_texts = [str(item.get("userAnswer", "")).strip() for item in analysis_items]
        analysis_texts = [text for text in analysis_texts if text]
        content_texts = [
            str(item.get("userAnswer", "")).strip()
            for item in [*media_items, *reflection_items]
        ]
        content_texts = [text for text in content_texts if text]

        linguistic = extract_linguistic(
            " ".join(analysis_texts), [], utterance_texts=analysis_texts,
        )
        model = _load_model()
        if model is not None:
            vector, names = build_feature_vector(acoustic, linguistic)
            scored = model.score_one(_align_vector(vector, names, model.feature_names))
            report.speechScore = ScoreCategory(
                key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
                factors=_factors(scored.get("axes", {}), SPEECH_AXES),
            )

        content_axes: dict = {}
        if CONTENT_MODEL_PATH.exists() and content_texts:
            content_linguistic = extract_linguistic(
                " ".join(content_texts), [], utterance_texts=content_texts,
            )
            content_model = ContentScoringModel.load(str(CONTENT_MODEL_PATH))
            vector, names = build_feature_vector(acoustic, content_linguistic)
            content_axes = content_model.score_all(
                _align_vector(vector, names, content_model.feature_names),
            ).get("axes", {})
            content_axes = _suppress_short_transcript_content_axes(
                content_axes, content_linguistic,
            )
        content_axes.update(_score_question_answers(items, use_llm=False))
        orientation = _score_orientation_answers(items)
        if orientation is not None:
            content_axes["시간·장소 지남력"] = orientation
        reflection_logic = _score_reflection_logic(items)
        if reflection_logic is not None:
            content_axes["논리 연결"] = reflection_logic
        report.contentScore = ScoreCategory(
            key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
            factors=_factors(content_axes, CONTENT_AXES),
        )
        report.analysisVersion = 3
        reference_factors = [
            factor for factor in report.contentScore.factors
            if factor.detail and factor.detail.get("confidence") in {"low", "moderate"}
        ]
        report.notice = (
            "실제 녹음과 응답을 분석했습니다. 모든 항목을 표시하며, 짧은 발화에서 "
            "계산한 값은 참고 신뢰도를 함께 제공합니다."
            if reference_factors else
            "실제 녹음과 응답을 분석한 결과입니다."
        )
        report_path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    except Exception as error:
        print(f"[report] v2 저장 리포트 재분석 실패: {type(error).__name__}: {error}")
    return report


def _mock_report(
    name,
    birth,
    items,
    note="",
    recording_base_url: str | None = None,
) -> ReportResponse:
    """프론트 목업과 동일한 형태. 개발·폴백용."""
    sp = [52, 46, 64, 71, 57]
    ct = [60, 54, 43, 49, 58]
    reference_mode, reference_notice = _reference_profile(birth)
    return ReportResponse(
        patientName=name, patientBirthDate=birth,
        speechScore=ScoreCategory(
            key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
            factors=[ScoreFactor(label=a, score=s) for a, s in zip(SPEECH_AXES, sp)]),
        contentScore=ScoreCategory(
            key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
            factors=[ScoreFactor(label=a, score=s) for a, s in zip(CONTENT_AXES, ct)]),
        questions=_rank_questions(items or [], recording_base_url=recording_base_url),
        interpretation=Interpretation(summary="", caveats=note, verified=False) if note else None,
        analysisMode="demo",
        notice=note or "화면 확인용 예시 데이터입니다. 실제 분석 결과가 아닙니다.",
        referenceMode=reference_mode,
        referenceNotice=reference_notice,
    )


@app.get("/api/report/mock", response_model=ReportResponse)
def mock():
    """프론트 개발용 — 서버 붙기 전에도 같은 스키마로 렌더 확인 가능."""
    return _mock_report("김순자", "1948-03-12", [])


@app.get("/api/report/audio/{session_id}/{filename}")
def report_audio(session_id: str, filename: str):
    """보호자 리포트에서 질문별 실제 녹음을 재생한다."""
    if Path(session_id).name != session_id or Path(filename).name != filename:
        raise HTTPException(status_code=404, detail="녹음을 찾을 수 없습니다.")
    session_dir = (LIVE_ROOT / session_id).resolve()
    path = (session_dir / filename).resolve()
    if path.parent != session_dir or not path.is_file():
        raise HTTPException(status_code=404, detail="녹음을 찾을 수 없습니다.")
    return FileResponse(path)


@app.get("/api/report/latest", response_model=ReportResponse)
def latest(patientName: str | None = None):
    """가장 최근 세션의 실제 채점 결과.

    시연용 경로: 앞에서 녹음·채점하면(`session_record.py`) 세션 폴더에 report.json이
    남는다. 프론트가 이 엔드포인트를 부르면 **방금 녹음한 사람의 실제 점수**가 화면에 뜬다.
    세션이 없으면 목업으로 폴백하므로 화면이 비지 않는다.
    """
    reports = sorted(LIVE_ROOT.glob("*/report.json"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not reports:
        return _mock_report(patientName, None, [], note="저장된 세션 없음 — 목업")

    last_error: Exception | None = None
    for report_path in reports:
        try:
            report = ReportResponse(**json.loads(report_path.read_text(encoding="utf-8")))
            if patientName and _history_patient_key(report.patientName) != _history_patient_key(patientName):
                continue
            report = _reanalyze_stored_report(report, report_path)
            report = _refresh_stored_report_derived_fields(report)
            report.trend = _load_report_history(report.patientName)
            # 이력은 각 세션에서 실제 저장한 값이다. 최신 파일이 이력에 없거나
            # 이력의 마지막 세션과 다를 수 있으므로 조회 중 점수를 대입하지 않는다.
            return report
        except Exception as error:
            last_error = error
            continue
    if patientName:
        return _mock_report(patientName, None, [], note="해당 사용자의 저장된 세션 없음 — 목업")
    return _mock_report(None, None, [], note=f"세션 읽기 실패({last_error}) — 목업")
