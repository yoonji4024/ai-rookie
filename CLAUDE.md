# AI 동반 미디어 시청 기반 인지 스크리닝 시스템

어르신이 평소처럼 드라마·뉴스를 시청하는 상황을 스크리닝 환경으로 활용.
시청 중 자연스러운 실시간 대화 + 시청 후 장면 순서 회상 → 객관적 근거 기반 보호자 리포트.
**AI는 진단명을 내리지 않는다.** 순서 오류·발화 신호 등 근거만 전달.

> 이 문서는 Claude Code 프로젝트 메모리다. 코딩 전 항상 이 파일을 기준으로 한다.
> 갱신일: 2026-07-16. (프로젝트 피벗: 회상대화 → 미디어 시청 기반 스크리닝. GPU 가용. Kang 데이터 확보)

---

## 0. 지금 상태 한눈에 (코딩 시작 전 필독)

- **GPU 가용**: A100 7/15~8/14. 무거운 실험은 서버에서, 골격·전처리는 로컬.
- **Kang 데이터 확보**: `data/Kang/` — 한국어 인터뷰 음성+CHAT 전사, **HC 37 / MCI 40** (wav+cha 쌍, 발화 타임스탬프 포함). 분류기(HC vs MCI) 실험 즉시 가능. **AD 라벨 없음** → AD AUC는 217 대기.
- **AI-Hub 217 여전히 BLOCKED**: 안심존 + IRB 선행. 안심존 내 학습 후 **모델만 반출** 전략.
- **우선순위**: Kang 로더 → 피처 추출 → HC/MCI 분류기 베이스라인 AUC → 이벤트 그래프·타이밍 게이트 골격.

---

## 1. 대회 제약

- 2026 인공지능 루키 대회 **국내 AI 트랙**. 본선 제출 **8/14 17:00**.
- **국내 기업 LLM만 사용 가능**: KT 믿:음 2.0, Upstage Solar Pro 2, LG EXAONE, SKT A.X K1, NC VARCO.
- OpenAI/Whisper 등 해외 모델 금지. STT는 **A.X STT** 사용.
- 위 제한은 **LLM** 대상. 탐지 분류기(XGBoost/MLP)의 학습 데이터 언어는 규정 대상 아님 → 영어 DementiaBank/ADReSS를 백업 학습에 사용 가능. 제안서에 경계 명시.

---

## 2. 핵심 설계

### 시나리오
1. **시청 중**: AI가 친구처럼 실시간 질문. **타이밍 게이트**가 질문 여부·시점을 제어해 시청을 방해하지 않음.
2. **시청 후**: 방금 본 콘텐츠의 **장면 순서 회상** 질문. 자막+타임스탬프로 구성된 **이벤트 그래프**가 ground truth → 자유 회상과 달리 응답의 정오·오류 유형을 객관 판정.
3. **리포트**: 진단명 없이 객관적 근거만 — **순서 오류 유형(omission, reversal, intrusion, cue-dependency)** + 발화 신호. 보호자는 해당 답변 영상을 직접 확인 가능.

### 이벤트 그래프 (ground truth)
- 소스: 자막(.srt + 타임스탬프), 뉴스 스크립트, A.X STT batch 출력 기반 텍스트.
- DramaQA 접근 요청 진행 중.

---

## 3. 아키텍처 — 3 에이전트

### ① 대화 AI (시청 중 실시간 상호작용)
- **타이밍 게이트** (`timing_gate.py`): 3단계 — **draft**(A.X K1, 질문 후보 최대 3개 + silence) → **judge**(EXAONE) → **refine**.
- rule-based **hard block** 레이어가 API 호출 전 RPS 제한 처리.
- NC VARCO: 페르소나 렌더링.

### ② 요약 에이전트
- 시청 세션 + 대화 내용을 구조화 JSON으로 압축 (API-only 제약 하 애플리케이션 레벨 컨텍스트 압축).
- **Upstage Solar Pro 2 + Solar Embedding**.
- **철칙: 대화·콘텐츠에 없는 내용 절대 생성 금지.** 스키마 고정 출력, 원문 근거(span) 보존.

### ③ 분석 에이전트 (윤지 담당)
- **순서 회상 분석**: 응답 순서 vs 이벤트 그래프 → **Kendall's tau** 기반 순서 정확도 + 오류 유형 분류(omission/reversal/intrusion/cue-dependency).
- **발화 신호 분석**: A.X STT 텍스트(언어 피처)와 **별도로 raw audio에서 librosa/praat로 음향 피처 독립 추출** — STT가 disfluency(filled pause, repetition, false start)를 정규화할 위험의 안전망.
- **탐지 분류기**: XGBoost / MLP — concat(음향, 언어) → 정상/MCI/AD 확률.
- **리포트 생성**: Solar Pro 2 — 비전문가용, "단정 진단 금지·참고용·의료진 상담 권유" 톤.
- **[확정 필요]** 순서 점수 + 발화 분류기 score의 최종 결합 규칙.

---

## 4. 파이프라인 — 훈련/런타임 2트랙

```
[훈련 트랙]  라벨 데이터 전사 ──→ 언어 피처 ─┐
            라벨 데이터 오디오 ──→ 음향 피처 ─┴→ 분류기 학습
[런타임 트랙] 유저 음성 ─┬─→ A.X STT → 언어 피처 + 회상 응답 텍스트 ─┐
                       └─→ 원본 오디오 → 음향 피처 ────────────────┴→ 분류기 추론 + 순서 분석
```

- **음향 피처는 STT를 거치지 않고 원본 오디오에서 직접 추출** (핵심 안전망).
- 리스크 — 도메인 시프트: STT의 disfluency 정규화, 검사 응답(217) vs 자연 대화 양식 차이. WER 측정으로 강건성 정량화.

---

## 5. KPI (정량 목표)

| 항목 | 목표 |
|---|---|
| AD vs 정상 탐지 AUC | ≥ 0.80 |
| MCI vs 정상 탐지 AUC | ≥ 0.74 (보조: Recall@90%Spec ≥ 0.60) |
| RAG 검색 정확도 | ≥ 80% |
| RAG 응답 정확도 | ≥ 80% |
| 분류 지연 | ≤ 5초 |
| RAG 응답 지연 | ≤ 10초 |

---

## 6. 피처 명세 (분석 에이전트)

concat(음향, 언어) → 단일 벡터. 근거: ADReSS/ADReSSo(언어 단독 76.85%, 음향 62.5%, **결합 85~89.6%**, 비편집 ASR 84%).

### 음향 (원본 오디오, librosa/parselmouth — STT 무관)
- pause ratio, 휴지 빈도/길이 분포 (발화 타임스탬프 활용)
- speech rate, articulation rate
- filled pause 비율
- F0 평균/변동성, jitter, shimmer
- MFCC 통계량

### 언어 (전사/STT 텍스트)
- 어휘 다양성: TTR, MATTR
- 통사 복잡도, idea density
- disfluency 마커: 반복, false start, 수정
- word-finding 신호: 내용어 앞 휴지, 대명사 과다
- 발화량/문장 길이 분포

### 순서 회상 (신규)
- Kendall's tau (응답 순서 vs 이벤트 그래프)
- 오류 유형 카운트: omission / reversal / intrusion / cue-dependency

---

## 7. 데이터

### 확보됨 — 즉시 사용 가능
- **Kang 코퍼스** (`data/Kang/`): 한국어 인터뷰, **HC 37 / MCI 40**, wav + CHAT(.cha) 전사(발화 타임스탬프, %mor 형태소 포함). HC vs MCI 분류기 학습·피처 검증에 바로 사용. 커밋 금지(.gitignore로 차단됨).
- **AI-Hub 130 「한국인 대화음성」**: 파이프라인 구축용. 치매 라벨 없음.

### 대기 / 백업
- **AI-Hub 217** (메인, AD 포함): 안심존 + IRB. 정상 2,424 / MCI 1,611 / AD 1,734. **안심존 내 학습 → 모델만 반출.** 발화 = CERAD-K/SNSB-II 검사 응답.
- **DementiaBank Pitt / ADReSS·ADReSSo** (백업): 영어. 217 불발 시 보험.
- **DramaQA**: 이벤트 그래프용, 접근 요청 진행 중.

### 데이터 경계 원칙
- 합성/증강 데이터는 **RAG·이벤트그래프 평가셋에만**. 탐지 분류기 학습은 **실데이터만**.

---

## 8. 모델 · API

| 모델 | 역할 | 엔드포인트 |
|---|---|---|
| SKT A.X K1 | 타이밍 게이트 draft, 실시간 질문 생성 | awf-gw.adot.ai |
| A.X STT | 런타임 STT, batch 전사 | adot |
| LG EXAONE | 타이밍 게이트 judge, 교차검증 | Friendli.ai 전용 엔드포인트 |
| KT 믿:음 2.0 | 탐지 근거 제시 | Friendli.ai 전용 엔드포인트 |
| Upstage Solar Pro 2 | 요약·Groundedness·리포트 생성 | api.upstage.ai |
| Solar Embedding | 임베딩 | api.upstage.ai |
| NC VARCO | 페르소나 | (설정 완료) |

- **⚠️ Friendli.ai**: `model` 필드에 모델명이 아니라 **엔드포인트 ID**.
- **API 키 하드코딩 금지** → `.env` + 환경변수.

---

## 9. 인터페이스 시그니처 (고정 — 팀원과 독립 작업 가능)

```python
# ① 대화 AI — timing_gate.py
def decide_question(context: dict) -> dict:
    """draft(A.X K1) → judge(EXAONE) → refine. {'action': 'ask'|'silence', 'question': str|None, 'timing': float}"""

# ② 요약 에이전트
def summarize(session: str) -> list[dict]:
    """세션 → 구조화 JSON. 없는 내용 생성 금지, span 보존."""
def embed(texts: list[str]) -> list[list[float]]: ...

# ③ 분석 에이전트 (윤지)
def extract_acoustic(audio_path: str) -> dict: ...
def extract_linguistic(transcript: str, word_timings: list[dict]) -> dict: ...
def build_feature_vector(acoustic: dict, linguistic: dict) -> "np.ndarray": ...
def predict(features) -> dict:
    """{'label': 'MCI', 'prob': {...}, 'top_features': [...]}"""
def score_recall_order(response_events: list[str], event_graph: list[dict]) -> dict:
    """{'kendall_tau': .., 'errors': {'omission': n, 'reversal': n, 'intrusion': n, 'cue_dependency': n}}"""
def generate_report(scores: dict) -> str:
    """Solar. 보호자용, 진단 단정 금지."""

# RAG — Solar
def generate_rag_answer(question: str, retrieved: list[str]) -> dict: ...

# 메모리
def write_memory(record: dict) -> None: ...
def read_memory(query_embedding, k: int) -> list[dict]: ...
```

---

## 10. 팀 · 일정

- **박윤지**(팀장): 데이터 전처리, 분석 에이전트(③), 인터페이스 통제
- 현진, 정윤, 호성, 한솔 | 지도: 심규홍 교수
- A100 GPU: 7/15~8/14. 제출: **8/14 17:00**.

---

## 11. 환경 · 레포

- Python venv: `venv` (Python 3.12). 패키지: `requirements.txt`.
- 레포: `/Users/parkyoonji/Desktop/SLPR/ai-rookie`. **키·실데이터·오디오 커밋 금지** (`.gitignore`).
- **작업 상태는 `PLAN.md`**. CLAUDE.md = 불변(아키텍처·제약·KPI·인터페이스), PLAN.md = 가변(todo·진행·블로커).

### 구조
```
ai-rookie/
  src/
    agents/
      conversation/    # ① 대화 AI — timing_gate.py (draft→judge→refine), 페르소나
      summary/         # ② 요약 에이전트 — Solar Pro2 + Embedding
      analysis/        # ③ 분석 에이전트 (윤지)
        features/      #    extract_acoustic.py, extract_linguistic.py, build_vector.py
        classifier.py  #    XGBoost/MLP, predict()
        recall.py      #    score_recall_order() — Kendall's tau, 오류 유형
        evaluate.py    #    AUC, Recall@90%Spec
        report.py      #    generate_report() — Solar, 보호자용
    event_graph/       # 이벤트 그래프 구축 — srt 파싱, STT batch, 스키마
    rag/               # retriever.py, generate.py, eval_set/
    memory/            # schema.py, store.py
    preprocessing/     # kang_loader.py, 전사 정제, train/test split
    common/            # interfaces.py, llm/(HTTP 래퍼), .env 로딩, pydantic 스키마
  configs/
  data/                # Kang(커밋 금지), 더미/샘플
  notebooks/
  tests/
  requirements.txt
  CLAUDE.md / PLAN.md / README.md
```

- LLM 호출은 `requests`/`httpx` (openai 패키지는 API 연결 테스트 한정).

### GPU — GPU Live 콘솔 (대회 제공 A100, 7/15~8/14)

- 접속: 콘솔에서 **워크로드 생성**(01 GPU&리소스 → 02 추가 설정 → 03 검토). 실행 방식 = 인터랙티브(Jupyter/SSH) 또는 배치(스크립트 등록).
- 인터랙티브 접속: Jupyter(초기 토큰 `ubuntu`) / SSH `ssh -i {PEM} ubuntu@proxy-app.{도메인} -p {포트}` / SFTP(동일 정보, FileZilla 또는 Web SFTP).
- **⚠️ 워크로드 볼륨은 종료 시 삭제될 수 있음** → 데이터·체크포인트·결과는 반드시 **마운트한 스토리지**(BOUND 상태)에 저장. 스토리지 밖 결과물은 복구 불가.
- **⚠️ 유휴 GPU 자동 회수 규칙** 존재 — GPU 사용률이 임계값 미만으로 유지되면 워크로드 회수될 수 있음. 장시간 방치 금지, 체크포인트 자주 저장.
- 커스텀 환경 필요 시: NGC 베이스(`nvcr.io/nvidia/pytorch:24.10-py3` 권장) Dockerfile — Jupyter/SSH/tini/supervisor 블록은 GPU Live 연동 규약이라 수정 금지, ② 패키지 블록에 requirements만 추가. `docker buildx build --platform linux/amd64 --push`로 레지스트리 등록 후 워크로드 실행 환경으로 지정.
- 워크플로: 로컬에서 코드 작성·더미 테스트 → git/SFTP로 서버 반입 → 스토리지에 데이터 배치 → 학습·실험 → 결과만 회수.

---

## 12. 코딩 원칙

- 모든 모듈은 **더미 입력으로 end-to-end 통과** 가능해야 함. 실데이터는 교체만.
- 분류기/평가는 데이터 교체 한 줄로 재실행(하드코딩 경로 금지).
- **subject-level split 필수** — 같은 화자의 샘플이 train/test에 갈리면 leakage.
- LLM 출력은 항상 JSON으로 받고 파싱.
- 요약·이벤트 그래프는 **원문 근거(span) 항상 보존**.
- 리포트 텍스트에 진단 단정 표현 금지.

---

## 13. 열린 항목 (미확정 — 가정하지 말고 플래그)

- 순서 점수 ↔ 발화 분류기 score 결합 규칙
- A.X STT의 disfluency 보존/정규화 여부, raw 출력 옵션
- 217 IRB 결과·안심존 반출 절차 (불발 시 DementiaBank 전환)
- DramaQA 접근 승인 여부
- 타이밍 게이트 judge 기준(EXAONE 프롬프트)·지연 예산
- Solar Embedding 2 대회 허용 범위
- Kang 코퍼스 사용 범위(라이선스·제안서 표기)
