#!/usr/bin/env bash
# GPU Live 서버 초기 세팅 — clone 직후 1회 실행.
#   bash setup_server.sh
# 전제: 이 스크립트가 있는 폴더 = 레포 루트. Kang 데이터는 별도로 data/Kang/ 에 배치.
set -euo pipefail
cd "$(dirname "$0")"

echo "== [1/5] Python / GPU 확인 =="
python3 --version
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || echo "  (nvidia-smi 없음 — CPU 노드?)"

echo "== [2/5] venv 생성 =="
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -q --upgrade pip

echo "== [3/5] 패키지 설치 (느린 다운로드 대비 재시도·타임아웃 상향) =="
# kiwipiepy_model(88MB)·praat-parselmouth(소스빌드)가 느릴 수 있어 옵션 강화
export PIP_DEFAULT_TIMEOUT=120
pip install --retries 10 -r requirements.txt

echo "== [4/5] 핵심 import 검증 =="
python - <<'PY'
import importlib
mods = ["numpy","scipy","sklearn","xgboost","librosa","soundfile","parselmouth","kiwipiepy"]
ok = True
for m in mods:
    try:
        importlib.import_module(m); print(f"  OK  {m}")
    except Exception as e:
        ok = False; print(f"  FAIL {m}: {e}")
import sys; sys.exit(0 if ok else 1)
PY

echo "== [5/5] Kang 데이터 확인 =="
if [ -d data/Kang/HC ] && [ -d data/Kang/MCI ]; then
  echo "  HC=$(ls data/Kang/HC/*.wav 2>/dev/null | wc -l)  MCI=$(ls data/Kang/MCI/*.wav 2>/dev/null | wc -l)"
else
  echo "  ⚠️ data/Kang/ 없음 — SFTP/Web SFTP로 스토리지에 업로드 후 다시 실행"
fi

echo
echo "완료. 베이스라인 재현:  source .venv/bin/activate && rm -f data/kang_features.npz && python -m src.agents.analysis.run_kang_baseline"
