"""Pitt(영어) 음향 지표 검증 — 우리 지표가 영어 치매도 잡는가.

목적 (교차언어 검증)
  Kang(한국어)에서 확인한 음향 지표가 영어 DementiaBank Pitt에서도
  정상 vs 치매를 가르는지 본다. 언어가 달라도 음향 신호가 유효하면,
  우리 지표가 언어 독립적으로 치매를 반영한다는 근거가 된다.

⚠️ 영어라 언어 피처(kiwipiepy·krr_*·내용축)는 제외. **음향 51개만** 사용.
⚠️ 화자 단위 CV — 같은 화자의 여러 회차가 train/test에 갈리면 leakage.
   Pitt은 종단 데이터라 특히 중요.

사용:
    python3 -m src.agents.analysis.features.eval_pitt --task cookie
    (선행: pitt_loader --convert 로 wav 준비)
"""
from __future__ import annotations

import argparse

import numpy as np
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from src.agents.analysis.classifier import make_xgb
from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.preprocessing.pitt_loader import load_pitt

# librosa가 mp3를 직접 읽으므로 wav 변환 불필요 (mp3 경로 그대로 extract_acoustic에 넣음)

# 음향(ac_*)만. Kang에서 검증된 주력 지표
VOICE_KEYS = ["ac_hnr", "ac_cpp", "ac_shimmer_local", "ac_jitter_local", "ac_f0_mean",
              "ac_pause_ratio", "ac_voiced_seg_rate"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="cookie")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    recs = load_pitt(task=a.task)
    if a.limit:
        # 라벨 균형 유지하며 축소
        c = [r for r in recs if r.label == "Control"][: a.limit // 2]
        d = [r for r in recs if r.label == "Dementia"][: a.limit // 2]
        recs = c + d

    X, y, groups, names = [], [], [], None
    for i, r in enumerate(recs, 1):
        ac = extract_acoustic(r.mp3_path)             # mp3 직접(librosa) · 전사 없어 전체 오디오
        vec, names = build_feature_vector(ac, {})     # 언어 피처 없이 음향만
        X.append(vec)
        y.append(0 if r.label == "Control" else 1)    # 이진: 정상 vs 치매
        groups.append(r.speaker_id)
        if i % 100 == 0:
            print(f"  피처 {i}/{len(recs)}")
    X, y, groups = np.vstack(X), np.array(y), np.array(groups)

    ac_idx = [i for i, n in enumerate(names) if n.startswith("ac_")]
    X = X[:, ac_idx]
    names = [names[i] for i in ac_idx]
    print(f"\n대상 {len(recs)}건 / 화자 {len(set(groups))}명 "
          f"(정상 {int((y==0).sum())} / 치매 {int((y==1).sum())}), 음향 {len(names)}피처")

    # 1) 주요 지표 방향 (Kang과 같은 방향인가)
    print("\n1) 주요 음향 지표 (정상 vs 치매 평균)")
    idx = {n: i for i, n in enumerate(names)}
    for k in VOICE_KEYS:
        if k not in idx:
            continue
        col = X[:, idx[k]]
        n_auc = roc_auc_score(y, col)
        n_auc = max(n_auc, 1 - n_auc)
        print(f"   {k:20s} 정상 {col[y==0].mean():8.3f} | 치매 {col[y==1].mean():8.3f} | AUC {n_auc:.3f}")

    # 2) 화자 단위 CV AUC
    print("\n2) 정상 vs 치매 분류 (화자 단위 5-fold, 음향만)")
    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
    oof = np.zeros(len(y))
    for tr, te in sgkf.split(X, y, groups):
        m = make_xgb().fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
    auc = roc_auc_score(y, oof)
    print(f"   AUC (OOF, 화자 leakage 차단): {auc:.3f}")
    print(f"   KPI (AD AUC ≥ 0.80): {'PASS' if auc >= 0.80 else 'MISS'}")


if __name__ == "__main__":
    main()
