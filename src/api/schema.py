"""프론트엔드(Rookie_2026_DEMO) 연동 스키마.

프론트의 TypeScript 타입을 그대로 옮긴 것. 필드명·형태를 바꾸면 프론트가 깨진다.
대응: src/components/GuardianDramaReport.tsx 의 타입 정의

  ScoreFactor      { label, score }
  ScoreCategory    { key: "speech"|"content", name, description, factors }
  ReportQuestion   { id, rank, impact, question, correctAnswer, userAnswer, videoTimestamp }
  TrendPoint       { date, label, speechFactors, contentFactors }

축 이름은 우리 rubric.py / rubric_content.py 와 이미 일치한다(변환 불필요).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ScoreFactor(BaseModel):
    label: str
    score: int = Field(ge=0, le=100)
    available: bool = True
    # validated=False는 계산식이 틀렸다는 뜻이 아니라, 현재 파일럿 표본으로
    # 인지 저하 판별력이 아직 검증되지 않은 관찰 축이라는 뜻이다.
    validated: bool | None = None
    detail: dict | None = None


class ScoreCategory(BaseModel):
    key: str                      # "speech" | "content"
    name: str
    description: str
    factors: list[ScoreFactor]


class ReportQuestion(BaseModel):
    id: str
    rank: int                     # 1이 기여도 최대
    impact: int = Field(ge=0, le=100)
    question: str
    correctAnswer: str
    userAnswer: str
    videoTimestamp: float
    # 채점 재현과 보호자 설명을 위해 실제 사용한 의미 키워드를 함께 보존한다.
    answerKeywords: list[str] = []
    # 검사 중 실제로 녹음한 사용자 음성. 보호자 화면은 TTS가 아니라 이 URL을 재생한다.
    recordingUrl: str | None = None
    responseType: Literal["question_answer", "free_recall"] = "question_answer"
    transcriptSource: Literal["recorded", "demo"] = "recorded"
    cuedSceneIds: list[str] | None = None


class TrendPoint(BaseModel):
    date: str
    label: str
    speechFactors: list[ScoreFactor]
    contentFactors: list[ScoreFactor]


class Interpretation(BaseModel):
    """근거 기반 해석 — 프론트 목업엔 없던 필드. 리포트 하단에 붙일 용도."""
    summary: str
    axisComments: dict[str, str] = {}
    caveats: str = ""
    recommendation: str = ""
    evidenceIds: dict[str, list[str]] = {}   # 축별 인용 근거 ID
    verified: bool = False                   # 검증 통과 여부
    verifyIssues: list[str] = []


class TTSProperties(BaseModel):
    speed: float = Field(default=0.95, ge=0.5, le=1.5)
    pitch: float = Field(default=1.0, ge=0.5, le=1.5)


class TTSRequest(BaseModel):
    """프런트가 요청하는 VARCO 질문 음성. API 키는 백엔드에서만 사용한다."""
    text: str = Field(min_length=1, max_length=400)
    language: Literal["korean"] = "korean"
    voice: str = Field(min_length=1, max_length=80)
    properties: TTSProperties = Field(default_factory=TTSProperties)
    n_fm_steps: int = Field(default=8, ge=8, le=20)
    seed: int = -1
    return_metadata: bool = False


class EmpathyRequest(BaseModel):
    """사용자 답변에 근거한 짧은 시청 동반 반응 요청."""
    questionId: str = Field(default="", max_length=80)
    question: str = Field(min_length=1, max_length=400)
    correctAnswer: str = Field(default="", max_length=1000)
    userAnswer: str = Field(default="", max_length=1000)
    answerKeywords: list[str] = Field(default_factory=list, max_length=20)
    # 사용자 답변을 처리하는 동안 먼저 재생한 장면별 감상. LLM은 이 문장을
    # 반복하지 않고 자연스럽게 이어지는 한 문장만 만든다.
    opener: str = Field(default="", max_length=300)
    # 같은 질문·답변에서도 세션마다 말투가 고정되지 않도록 프런트가 보내는 값.
    # 의미 판정에는 사용하지 않고 안전한 반응 스타일 선택에만 쓴다.
    variationKey: str = Field(default="", max_length=120)


class ReportResponse(BaseModel):
    patientName: str | None = None
    patientBirthDate: str | None = None
    speechScore: ScoreCategory
    contentScore: ScoreCategory
    questions: list[ReportQuestion] = []
    trend: list[TrendPoint] = []
    interpretation: Interpretation | None = None
    analysisMode: Literal["scored", "partial", "demo"] = "demo"
    notice: str = ""
    # 현재 참조표본 연령 범위(60~79세) 안에서는 집단 참조, 그 밖에서는
    # 같은 사람의 회차 변화만 해석한다. 생일 기억 답변 자체는 여기에 쓰지 않는다.
    referenceMode: Literal["older_reference", "personal_baseline"] = "personal_baseline"
    referenceNotice: str = ""
    analysisVersion: int = 1
    # 자유 회상만 별도로 관찰. 일반 문답의 배열 순서를 회상 순서로 쓰지 않는다.
    recallObservations: dict | None = None


class AnswerIn(BaseModel):
    """질문 1건에 대한 응답. 오디오는 multipart로 별도 전송."""
    id: str
    question: str
    correctAnswer: str = ""
    userAnswer: str = ""          # 비우면 STT로 채움
    fallbackAnswer: str = ""      # STT 장애 시에만 사용하는 고지된 시연 전사
    transcriptSource: Literal["recorded", "demo"] = "recorded"
    videoTimestamp: float = 0.0
    audioFilename: str | None = None   # 업로드 파일명과 매칭
    responseType: Literal["question_answer", "free_recall"] = "question_answer"
    # None=단서 이력 미기록, []=단서 제공 안 함을 기록한 경우.
    cuedSceneIds: list[str] | None = None
