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
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from src.api.schema import (
    Interpretation,
    ReportQuestion,
    ReportResponse,
    ScoreCategory,
    ScoreFactor,
)

app = FastAPI(title="AI Rookie 채점 API", version="0.1.0")

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
    except Exception:
        pass


MODEL_PATH = Path("configs/scoring_model.json")
CONTENT_MODEL_PATH = Path("configs/scoring_model_content.json")

SPEECH_AXES = ["버벅임", "침묵 시간", "발화 속도", "발음 정확도", "문장 완성도"]
CONTENT_AXES = ["단어 수준", "문맥 일치도", "기억 정확도", "시간·장소 지남력", "논리 연결"]

_model = None


def _load_model():
    """참조분포 로드 (없으면 None → mock 폴백)."""
    global _model
    if _model is None and MODEL_PATH.exists():
        from src.agents.analysis.scoring.score import ScoringModel
        _model = ScoringModel.load(str(MODEL_PATH))
    return _model


def _factors(axes: dict, order: list[str]) -> list[ScoreFactor]:
    """점수 dict → 프론트 순서대로 정렬된 factor 배열.

    NaN 방어: 피처 하나가 NaN이면 축 z가 NaN이 되고 int(nan)이 예외를 던진다
    (예: 무음 구간이라 praat이 음질 계산에 실패). 화면이 통째로 죽는 것보다
    해당 축을 0으로 표시하는 편이 낫다.
    """
    import math
    out = []
    for label in order:
        v = axes.get(label)
        raw = (v.get("score") if isinstance(v, dict) else v) if v is not None else 0
        try:
            s = float(raw)
            s = 0.0 if math.isnan(s) or math.isinf(s) else s
        except (TypeError, ValueError):
            s = 0.0
        out.append(ScoreFactor(label=label, score=int(round(min(max(s, 0), 100)))))
    return out


def _stt(path: str) -> str:
    """A.X STT로 전사. 참가자(주 화자) 발화만 뽑는다.

    text·main_speaker는 property라 괄호 없이 접근한다.
    런타임은 사용자 혼자 말하므로 화자가 1명이지만, 잡음으로 분리가 갈릴 수 있어
    최장 화자만 취한다.
    """
    from src.common.stt import AXSTT
    tr = AXSTT().transcribe(path)
    main = tr.main_speaker
    if main is None:
        return tr.text
    return " ".join(u.text for u in tr.by_speaker(main) if u.text)


def _health() -> dict:
    return {"ok": True, "scoring_model": MODEL_PATH.exists(),
            "content_model": CONTENT_MODEL_PATH.exists()}


@app.get("/health")
def health():
    return _health()


# /api 아래에도 노출 — 프론트 vite 프록시가 /api/score/* 만 중계하므로
# 프론트에서 상태를 확인하려면 이 경로가 필요하다.
@app.get("/api/health")
def api_health():
    return _health()


@app.post("/api/report", response_model=ReportResponse)
async def make_report(
    answers: str = Form(..., description="AnswerIn[] JSON 문자열"),
    patientName: str | None = Form(None),
    patientBirthDate: str | None = Form(None),
    contentId: str | None = Form(None, description="시청 콘텐츠 ID (회상 축 채점에 필요)"),
    audio: list[UploadFile] = File(default=[]),
):
    """예외가 나도 500 대신 목업을 돌려준다 — 시연 중 화면이 죽지 않게."""
    try:
        return await _make_report(answers, patientName, patientBirthDate, audio, contentId)
    except Exception as e:
        import traceback
        traceback.print_exc()          # 서버 콘솔에는 전체 트레이스백을 남긴다
        try:
            items = json.loads(answers)
        except Exception:
            items = []
        return _mock_report(patientName, patientBirthDate, items,
                            note=f"채점 실패({type(e).__name__}: {e}) — 목업 반환")


async def _make_report(
    answers: str,
    patientName: str | None,
    patientBirthDate: str | None,
    audio: list[UploadFile],
    contentId: str | None = None,
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

    tmp = Path(tempfile.mkdtemp(prefix="session_"))
    saved: dict[str, Path] = {}
    for up in audio:
        dst = tmp / Path(up.filename or "audio.wav").name
        with open(dst, "wb") as fh:
            shutil.copyfileobj(up.file, fh)
        saved[dst.name] = dst

    model = _load_model()
    if model is None or not saved:
        # 참조분포나 오디오가 없으면 채점 불가 → 목업 형태로 반환(형태는 동일)
        return _mock_report(patientName, patientBirthDate, items,
                            note="참조분포 또는 오디오 없음 — 목업 반환")

    # ── 2) 음향 피처 ────────────────────────────────────────
    from src.agents.analysis.features.build_vector import build_feature_vector
    from src.agents.analysis.features.extract_acoustic import extract_acoustic

    main_audio = next(iter(saved.values()))
    acoustic = extract_acoustic(str(main_audio))

    # ── 3) 응답 텍스트 (없으면 STT) ─────────────────────────
    stt_error = ""
    for it in items:
        if not it.get("userAnswer"):
            fn = it.get("audioFilename")
            if fn and fn in saved:
                try:
                    it["userAnswer"] = _stt(str(saved[fn]))
                except Exception as e:      # STT 실패해도 음향 채점은 계속한다
                    it["userAnswer"] = ""
                    stt_error = f"STT 실패: {type(e).__name__}: {e}"

    # ── 4) 언어 피처 + 채점 ─────────────────────────────────
    transcript = " ".join(it.get("userAnswer", "") for it in items)
    try:
        from src.agents.analysis.features.extract_linguistic import extract_linguistic
        linguistic = extract_linguistic(transcript, [])
    except Exception:
        linguistic = {}

    vec, names = build_feature_vector(acoustic, linguistic)
    scored = model.score_one(vec)
    axes = scored.get("axes", {})

    speech = ScoreCategory(
        key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
        factors=_factors(axes, SPEECH_AXES),
    )

    # 내용 점수 — 전사 기반 3축(참조분포) + 회상 기반 2축(이벤트 그래프 정답 대비)
    content_axes: dict = {}
    recall_out: dict | None = None
    if CONTENT_MODEL_PATH.exists():
        try:
            from src.agents.analysis.scoring.score_content import ContentScoringModel
            cm = ContentScoringModel.load(str(CONTENT_MODEL_PATH))

            # contentId가 오면 회상 축까지 채운다. 없으면 전사 3축만.
            n_scenes = 0
            if contentId and transcript.strip():
                try:
                    from src.agents.analysis.recall import score_recall_order
                    from src.agents.analysis.response_matcher import match_response
                    from src.event_graph.sample_loader import load_all
                    graph = {g.content_id: g for g in load_all()}.get(contentId)
                    if graph is not None:
                        n_scenes = len(graph.nodes)
                        m = match_response(transcript, graph, use_llm=False)
                        recall_out = score_recall_order(m.get("scene_order", []), graph)
                        recall_out["scene_order"] = m.get("scene_order", [])
                except Exception:
                    recall_out = None

            content_axes = cm.score_all(vec, recall=recall_out,
                                        n_scenes=n_scenes).get("axes", {})
        except Exception:
            content_axes = {}
    content = ScoreCategory(
        key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
        factors=_factors(content_axes, CONTENT_AXES),
    )

    # ── 5) 근거 검색 → 해석 → 검증 ──────────────────────────
    interp = None
    try:
        from src.agents.analysis.scoring.interpret import interpret_scores
        # max_retries=1: 생성→검증→(실패 시)재생성 1회까지.
        # 서빙 경로라 응답 시간이 중요하다. 재시도를 늘리면 LLM 호출이 곱으로 늘어난다.
        out = interpret_scores(scored, max_retries=1)
        rep, v = out["report"], out.get("verify") or {}
        interp = Interpretation(
            summary=rep.get("summary", ""),
            axisComments=rep.get("axis_comments", {}),
            caveats=rep.get("caveats", ""),
            recommendation=rep.get("recommendation", ""),
            evidenceIds=out.get("evidence", {}),
            verified=bool(v.get("pass")),
            verifyIssues=v.get("issues", []),
        )
    except Exception as e:
        interp = Interpretation(summary="", caveats=f"해석 생성 실패: {e}", verified=False)

    # STT가 실패했으면 사유를 리포트에 남긴다 — 언어·내용 축이 0으로 나온 이유가 됨
    if stt_error:
        interp.caveats = (interp.caveats + " / " if interp.caveats else "") + stt_error

    questions = _rank_questions(items)
    return ReportResponse(
        patientName=patientName, patientBirthDate=patientBirthDate,
        speechScore=speech, contentScore=content,
        questions=questions, trend=[], interpretation=interp,
    )


def _rank_questions(items: list[dict]) -> list[ReportQuestion]:
    """응답을 기여도 순으로. 지금은 입력 순서 유지 + impact 균등 배분.

    ⚠️ 실제 기여도(어느 질문이 판단에 얼마나 기여했는지)는 파일럿 세션으로
       순서 회상 축을 검증한 뒤 확정한다. 그전까지 임의 가중치를 쓰지 않는다.
    """
    out = []
    n = max(len(items), 1)
    for i, it in enumerate(items):
        out.append(ReportQuestion(
            id=str(it.get("id", f"q{i+1}")),
            rank=i + 1,
            impact=int(round(100 - (i * (60 / n)))),
            question=it.get("question", ""),
            correctAnswer=it.get("correctAnswer", ""),
            userAnswer=it.get("userAnswer", ""),
            videoTimestamp=float(it.get("videoTimestamp", 0)),
        ))
    return out


def _mock_report(name, birth, items, note="") -> ReportResponse:
    """프론트 목업과 동일한 형태. 개발·폴백용."""
    sp = [52, 46, 64, 71, 57]
    ct = [60, 54, 43, 49, 58]
    return ReportResponse(
        patientName=name, patientBirthDate=birth,
        speechScore=ScoreCategory(
            key="speech", name="발화 점수", description="말의 유창성과 전달력을 평가해요",
            factors=[ScoreFactor(label=a, score=s) for a, s in zip(SPEECH_AXES, sp)]),
        contentScore=ScoreCategory(
            key="content", name="내용 점수", description="답변 내용의 정확성과 수준을 평가해요",
            factors=[ScoreFactor(label=a, score=s) for a, s in zip(CONTENT_AXES, ct)]),
        questions=_rank_questions(items or []),
        interpretation=Interpretation(summary="", caveats=note, verified=False) if note else None,
    )


@app.get("/api/report/mock", response_model=ReportResponse)
def mock():
    """프론트 개발용 — 서버 붙기 전에도 같은 스키마로 렌더 확인 가능."""
    return _mock_report("김순자", "1948-03-12", [])


LIVE_ROOT = Path("data/live")


@app.get("/api/report/latest", response_model=ReportResponse)
def latest():
    """가장 최근 세션의 실제 채점 결과.

    시연용 경로: 앞에서 녹음·채점하면(`session_record.py`) 세션 폴더에 report.json이
    남는다. 프론트가 이 엔드포인트를 부르면 **방금 녹음한 사람의 실제 점수**가 화면에 뜬다.
    세션이 없으면 목업으로 폴백하므로 화면이 비지 않는다.
    """
    reports = sorted(LIVE_ROOT.glob("*/report.json"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not reports:
        return _mock_report(None, None, [], note="저장된 세션 없음 — 목업")
    try:
        d = json.loads(reports[0].read_text(encoding="utf-8"))
        return ReportResponse(**d)
    except Exception as e:
        return _mock_report(None, None, [], note=f"세션 읽기 실패({e}) — 목업")
