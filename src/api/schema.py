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

from pydantic import BaseModel, Field


class ScoreFactor(BaseModel):
    label: str
    score: int = Field(ge=0, le=100)


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


class ReportResponse(BaseModel):
    patientName: str | None = None
    patientBirthDate: str | None = None
    speechScore: ScoreCategory
    contentScore: ScoreCategory
    questions: list[ReportQuestion] = []
    trend: list[TrendPoint] = []
    interpretation: Interpretation | None = None


class AnswerIn(BaseModel):
    """질문 1건에 대한 응답. 오디오는 multipart로 별도 전송."""
    id: str
    question: str
    correctAnswer: str = ""
    userAnswer: str = ""          # 비우면 STT로 채움
    videoTimestamp: float = 0.0
    audioFilename: str | None = None   # 업로드 파일명과 매칭
