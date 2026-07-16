# AI 동반 미디어 시청 기반 인지 스크리닝 시스템

2026 인공지능 루키 대회 국내 AI 트랙 · 성균관대학교 소프트웨어학과

어르신이 평소처럼 드라마·뉴스를 시청하는 상황을 스크리닝 환경으로 활용한다.
시청 중 자연스러운 실시간 대화 + 시청 후 장면 순서 회상 → 객관적 근거 기반 보호자 리포트.
**AI는 진단명을 내리지 않는다.** 순서 오류·발화 신호 등 근거만 전달한다.

> 설계·아키텍처·KPI·인터페이스는 **CLAUDE.md**, 작업 상태·todo는 **PLAN.md**, GPU 서버 세팅은 **SETUP_GPU.md** 참고.

## Setup (로컬)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 키 입력 (없으면 .env 직접 작성)
```

## Kang 베이스라인 실행

```bash
# data/Kang/{HC,MCI}/ 에 wav+cha 배치 후
python -m src.agents.analysis.run_kang_baseline
```

HC vs MCI 분류: 로더 → 음향/언어 피처 → XGBoost subject-level 5-fold CV → AUC + Recall@90%Spec.

## GPU Live 서버

VSCode Remote-SSH 연결 및 서버 실험은 **SETUP_GPU.md** 및 `setup_server.sh` 참고.
