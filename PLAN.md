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