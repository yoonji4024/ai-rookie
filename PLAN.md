# PLAN — 미디어 시청 기반 인지 스크리닝 작업 보드

> 작업 상태 전용. **설계 진실은 CLAUDE.md, 지금 뭐 할지는 여기.**
> 갱신일: 2026-07-16. (프로젝트 피벗 반영, Kang 데이터 실험 스프린트 시작)

---

## 환경 상태 (코딩 전 확인)
- 데이터: **Kang 코퍼스 확보** (HC 37 / MCI 40, wav+cha) — HC vs MCI 즉시 실험 가능. AI-Hub 217은 여전히 IRB/안심존 대기.
- GPU: **GPU Live A100 가용** (7/15~8/14). 인터랙티브(Jupyter/SSH) 또는 배치. ⚠️ 결과는 스토리지에만 보존, 유휴 회수 주의.
- 로컬 환경: venv에 requirements 미설치 상태 → 설치 필요. git 저장소 미초기화.
- 마감: 본선 제출 **8/14 17:00**.

---

## 스코어링 (발화 5축) — 2026-07-16 구현
- 루브릭 `src/agents/analysis/scoring/rubric.py`: 버벅임·침묵시간·발화속도·발음정확도·문장완성도, 각 0~100 + 등급(정상≥70/위험≥50/심각).
- **설계 원칙**: ①방향은 데이터가 결정(직관과 반대인 축 존재 — HC가 오히려 더 자주 쉼) ②말길이 편향 피처 제외 ③HC 기준 z→100·Φ(z+1) (HC평균≈84, -1SD≈50) ④높을수록 정상.
- 규칙 채점(`score.py`) + 솔라 해석(`report_solar.py`, solar-pro2). **점수는 규칙, 해석만 LLM** — 재현·방어 가능.
- 검증: `validate.py`(등급경계·축별판별력, fold내 fit로 leakage 차단), `validate_solar.py`(스키마·근거성·금지어·재현성).
- 로컬 중간결과(구 캐시, 발음정확도 축 제외): 총점 AUC 0.755, HC 76.9 vs MCI 62.4, **등급 단조성 OK(정상 37%→위험 59%→심각 92% MCI)**.
- **서버 검증 완료(67피처)**: 총점 AUC **0.859** (HC 78.6 vs MCI 56.1). 축별 AUC — 발화속도 0.814, 문장완성도 0.791, 발음정확도 0.785, 침묵시간 0.693, 버벅임 0.684.
- **등급 컷 확정: 정상≥70 / 위험≥45** (구 50에서 하향). 인원 42/25/10, MCI비율 24%→80%→**100%**(심각 전원 MCI), 단조성 위배 해결.
- 솔라 1차 검증 2/3 통과(1회 환각 수치 인용) → **온도 0.0 + 숫자 인용 규칙 강화 + 생성→검증→재시도 에이전트 루프**(`generate_speech_report_verified`) 추가.
- **최종 검증 완료(2026-07-21, 서버)**:
  - 등급 단조성 **OK** — 정상 32HC/10MCI(24%) · 위험 5HC/20MCI(80%) · 심각 **0HC/10MCI(100%)**. 심각 등급 순도 100%.
  - 솔라 **3/3 PASS, 전부 1회 시도** (스키마·근거성·금지어 통과). 출력 558자±69, 점수 인용 일관성 OK.
  - **스코어링 파트 완료.** 총점 AUC 0.859 / 5축 전부 판별력 확보 / 등급 신뢰 / 솔라 검증 통과.
- ⏭ 남은 것: 축 가중치 조정(선택 — 균등 vs 판별력 가중), **영어 DementiaBank Pitt 적용**.

## 미디어 파이프라인 (Sample 데이터) — 2026-07-21 구현
- **데이터 확보**: `data/Sample/` AI-Hub 방송콘텐츠 4편(뉴스·교양·문화·생활). mp4 + 라벨링 JSON(타임스탬프 전사 + 하이라이트: 구간·요약·키워드·user_query 6개).
  → **DramaQA 대기 해소.** 이벤트 그래프 소스 확보.
- `src/event_graph/sample_loader.py`: JSON → **EventGraph**(하이라이트=장면 노드, 시간순=정답 순서, 근거 transcript span 보존).
- `src/agents/analysis/recall.py`: **score_recall_order()** — Kendall's tau + omission/reversal/intrusion/cue_dependency. CLAUDE.md §9 시그니처 준수. 6개 케이스 검증 통과.
- `src/event_graph/extract_audio.py`: mp4 → 16kHz mono wav(ffmpeg). **기존 음향 파이프라인(51피처) 그대로 적용 확인**.
- `src/event_graph/build_dataset.py`: 이벤트그래프 12장면 / 순서회상 질문 4개 / **질문 평가셋 72개** 생성 + 검증(시간순·비겹침·근거존재·채점기 정합) 전부 통과.
- **서버 재현 완료(2026-07-21)**: 4개 콘텐츠 전부 음향 피처 51개 추출 성공(교양 845s/뉴스 1117s/문화 690s/생활 813s). Kang 인터뷰용 음향 분석이 **실제 방송 콘텐츠에도 그대로 적용됨**을 확인.
- 트러블슈팅 기록:
  - `.gitignore`의 `!data/sample/`(소문자)가 macOS 대소문자 미구분 탓에 `data/Sample/`(533MB)까지 허용 → 633MB push 실패. 예외 제거 + 미디어 확장자 이중 차단으로 해결.
  - **macOS(NFD) ↔ 리눅스(NFC) 한글 파일명 인코딩 차이**로 서버에서 경로 매칭 실패. 한글 폴더명 하드코딩 제거, JSON 내용으로 라벨 파일 식별하도록 변경.
  - 서버 로케일 POSIX → `LANG=C.UTF-8` 설정(한글 출력·글롭).

## end-to-end 파이프라인 (프론트 없이) — 2026-07-21
- `src/common/llm.py`: **국내 LLM 4종 통합 클라이언트**(A.X K1·EXAONE·Solar·믿음). Friendli 엔드포인트ID 규약 반영, JSON 파싱 방어, `health_check()`.
  - **`LLM_MOCK=1` mock 모드** — 네트워크 없이 파이프라인 전 구간 구조 검증 가능(로컬 개발용).
- `src/agents/conversation/timing_gate.py`: **decide_question()** — hard block(질문간격 90s·장면경계±3s·상한 5회·발화중) → draft(A.X K1) → judge(EXAONE) → refine. 실패 시 보수적 침묵.
- `src/agents/analysis/response_matcher.py`: **자유발화 → scene_id** 매칭. 키워드 규칙 우선 + Solar 보정, 근거 보존, 확신 없으면 매칭 보류.
- `src/session.py`: **CLI 세션 오케스트레이터**. 시청 시뮬→타이밍게이트 질문→응답수집→순서회상→매칭→채점→리포트→JSON 저장. `Responder` 클래스만 갈아끼우면 프론트·STT 연결 가능.
- ✅ mock 모드 end-to-end 통과. 전 모듈 임포트·§9 시그니처 검증 완료.
- 🐛 **중요 버그 수정**: 여러 장면이 공통 키워드('미국')를 가지면 한 번 언급이 여러 장면에 매칭돼 **실제 누락을 정상 회상으로 오판**. → 고유 키워드만 규칙 매칭에 사용하도록 수정(모호하면 LLM/보류).
- ⏭ 서버에서 실제 LLM으로 검증(`health_check` → 세션 실행), 영어 데이터는 확보 후.

## NOW (이번 스프린트 — Kang 베이스라인)
- [ ] (P0) Kang 로더 — `src/preprocessing/kang_loader.py`: .cha 파싱(발화·타임스탬프·라벨) + wav 매핑
- [ ] (P0) 피처 추출 — extract_acoustic(librosa/parselmouth) / extract_linguistic(kiwipiepy)
- [ ] (P0) XGBoost 베이스라인 — HC vs MCI, **subject-level CV**, AUC + Recall@90%Spec
- [ ] (P0) 결과 검증 — leakage 점검, 피처 sanity check, 재현 확인
- [ ] (P1) venv requirements 설치 + git init

## BACKLOG (우선순위)
- [ ] (P1) 이벤트 그래프 골격 — srt 파싱, 스키마, score_recall_order(Kendall's tau + 오류 유형)
- [ ] (P1) 타이밍 게이트 stub — timing_gate.py (draft→judge→refine, hard block)
- [ ] (P1) 3에이전트 인터페이스 stub — interfaces.py
- [ ] (P2) MLP 실험 (GPU Live에서), 피처 ablation (음향 vs 언어 vs 결합)
- [ ] (P2) A.X STT batch 전사 → STT 기반 언어 피처 vs gold 전사 비교 (도메인 시프트 정량화)
- [ ] (P2) 리포트 생성(Solar) 프롬프트 골격

## BLOCKED / 대기
- [ ] AI-Hub 217 IRB·안심존 (불발 시 DementiaBank 전환)
- [ ] DramaQA 접근 승인
- [ ] 순서 점수 ↔ 분류기 score 결합 규칙
- [ ] A.X STT disfluency 보존 여부 확인

---

## 진행 로그
- 2026-06-30: 레포 셋업 정리(.gitignore / requirements.txt / PLAN.md).
- 2026-07-16: 프로젝트 피벗 반영 — CLAUDE.md 재작성(미디어 시청 스크리닝, GPU Live 가이드 반영), Kang 데이터 확인(HC 37/MCI 40), 실험 스프린트 시작.
- 2026-07-16: **Kang HC vs MCI 베이스라인 end-to-end 통과.** 로더+음향/언어 피처(53차원)+XGBoost 5-fold subject-level CV. MCI AUC 0.833(seed=42), 5-seed 평균 0.885 → KPI(≥0.74) PASS. 재현성 확인.
  - ⚠️ 검증 이슈 1: 상위 피처가 발화량 계열(phonation_time, total_speech_dur, n_morphemes). HC가 훨씬 길게 말함(708s/1325형태소 vs 449s/738). 발화량 계열만으로 AUC 0.849, 제거해도 0.815 → 신호는 실재하나 "말 많이 함" 교란 가능. 발화당 정규화 피처로 재검토 필요.
  - ⚠️ 검증 이슈 2: pause_ratio ≈ 0 (양 그룹). 현재 PAR 발화 구간 내부만 무음 탐지 → 발화 간 휴지 미포착. 오디오 세그멘테이션 재설계 필요(disfluency=핵심 신호).
  - ⚠️ 환경: kiwipiepy(88MB 모델)·praat-parselmouth(소스빌드) 로컬 다운로드 지연 → 현재 언어=정규식 fallback, 음향 F0/jitter/shimmer=0. **GPU Live 서버에서 정식 설치 후 재측정 필요.** 코어 스택(scipy/sklearn/xgboost/librosa)은 설치 완료.
- 2026-07-16 (서버, A100): GPU Live 워크로드 세팅 완료 — scp로 Kang 2GB 전송, `~/data`(NAS) 보존. venv 실패 → 시스템 파이썬에 `sudo pip install praat-parselmouth kiwipiepy`로 해결.
  - **praat·kiwi 정식 동작 후 진짜 베이스라인: MCI AUC 0.874, Recall@90%Spec 0.500 (KPI PASS).**
  - 음향 진단(diagnose_acoustic): **음질 피처가 깨끗한 신호로 확인** — shimmer AUC 0.762, f0_mean 0.716, jitter 0.713 (발화량 무관). MCI가 shimmer/jitter↑, f0↓.
  - 잔여 과제(음성 담당): 발화량 교란(total_speech_dur 0.866 최상위), pause 0비율 43~58%(불안정). → 음질 패널 확장 + pause 안정화 + 음향-only/발화량 제거 ablation.
- 2026-07-16 (서버): **음향 피처 확장(37→55) 완료.** 음질 패널(jitter 3종·shimmer 3종·HNR·f0_cv) + 스펙트럼(centroid/bw/rolloff/zcr/rms) + pause 안정화(top_db 30, ≥100ms, time_ratio·long_pause 추가).
  - 결과: baseline AUC **0.876**, 음향만 0.864. **pause 안정화 성공**(pause_ratio 0비율 16%→6%, AUC 0.799; pause 그룹만 0.792).
  - **발화량 교란 방어 확보: ablation '음향−발화량 제거' AUC 0.803** (duration 2개 빼도 유지).
  - 음질 검증: HNR 0.774, shimmer 0.76대, jitter 0.70~0.73, f0_mean 0.716 (전부 발화량 무관). ⚠️ spectral 그룹 0.543(ZCR 0.709만 유효) → 정리 대상.
  - 다음(음성): spectral 정리(ZCR만) + 음질 심화(포먼트 F1~F3·CPP).
- 2026-07-16 (음성 2차 확장, 로컬 검증 완료): 음향 55→57.
  - **음질 심화**: 포먼트 F1~F3(평균/표준편차) + CPP 추가.
  - **spectral 정리**: centroid/bw/rolloff/rms 제거(판별력 0.5대), ZCR만 유지.
  - **tempo 신규**: voiced-segment rate/run 통계(발화 분절성, 텍스트 무관).
  - ablation에 tempo 그룹 추가. 로컬 end-to-end 통과(NaN/inf 없음).
- 2026-07-16 (서버 2차 재측정): **전체 AUC 0.894** (세션 최고). tempo 신규 clean win — voiced_run_mean/seg_rate 각 0.753. CPP 성공(0.737, HC>MCI). '음향−발화량 제거' 0.804 유지.
  - ⚠️ 포먼트 실패: f1_mean 0.503(죽음)~f3_std 0.651, voice 그룹 개선 0 → **제거 결정**.
- 2026-07-16 (음성 3차, 로컬 검증): **포먼트 6개 제거, CPP 유지.** 음향 57→51. 슬림화로 과적합 감소·음향-only AUC 회복 기대. **서버 재측정 대기.**
  - 음질 그룹 확정: f0(4)·jitter(3)·shimmer(3)·HNR·CPP. tempo(voiced 3)·pause(6)와 함께 발화량 무관 주력 신호.
- 2026-07-16 (음성 3차 재측정, CPP 최적화): **포먼트 제거 효과 검증 완료.**
  - 음향-only AUC **0.854→0.871** (약한 포먼트 6개 제거로 상승, 슬림화=과적합↓).
  - **'음향−발화량 제거' 0.804→0.813** (교란 방어 강화). **Recall@90%Spec 0.500→0.550** (세션 최고, 보조목표 0.60 근접).
  - 전체 0.889 (0.894와 동일, 피처 6개↓로 더 강건). CPP 60초 샘플 유효(voice 그룹 0.728 유지).
  - ⚠️ 추출 여전히 ~9.7분(581s) — 잔여 병목은 전체오디오 pitch/jitter/shimmer/HNR. 반복 잦으면 이것도 캡 검토.
  - **음향 모듈 정리 완료: pause(0.783)·tempo(0.744)·음질(0.728)·MFCC(0.761), 발화량 교란은 ablation으로 방어(0.813).**