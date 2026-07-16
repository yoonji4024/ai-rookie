"""Kang HC vs MCI 베이스라인 실험 — end-to-end.

로드 → 피처 추출(캐시) → XGBoost subject-level CV → AUC/Recall 리포트.

사용:
    python -m src.agents.analysis.run_kang_baseline
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from src.preprocessing.kang_loader import load_kang
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.agents.analysis.features.extract_linguistic import extract_linguistic
from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.classifier import make_xgb
from src.agents.analysis.evaluate import cross_validate

CACHE = Path("data/kang_features.npz")


def build_dataset(use_cache: bool = True):
    if use_cache and CACHE.exists():
        d = np.load(CACHE, allow_pickle=True)
        return d["X"], d["y"], list(d["names"]), list(d["ids"])

    recs = load_kang()
    X, y, ids = [], [], []
    names = None
    for i, r in enumerate(recs):
        segs = [(w["startTime"], w["endTime"]) for w in r.word_timings]
        ac = extract_acoustic(r.wav_path, segments=segs)
        lg = extract_linguistic(r.par_text, r.word_timings)
        vec, nm = build_feature_vector(ac, lg)
        names = nm
        X.append(vec)
        y.append(1 if r.label == "MCI" else 0)
        ids.append(r.subject_id)
        print(f"  [{i+1}/{len(recs)}] {r.subject_id}  dim={len(vec)}")

    X = np.vstack(X)
    y = np.array(y)
    CACHE.parent.mkdir(exist_ok=True)
    np.savez(CACHE, X=X, y=y, names=np.array(names), ids=np.array(ids))
    return X, y, names, ids


def main():
    t0 = time.time()
    X, y, names, ids = build_dataset()
    print(f"\ndataset: X={X.shape}, HC={int((y==0).sum())} MCI={int((y==1).sum())}, {len(names)} features")

    res = cross_validate(make_xgb, X, y, n_splits=5)
    print("\n=== XGBoost (음향+언어, subject-level 5-fold CV) ===")
    print(f"  AUC (OOF)        : {res['auc_oof']:.3f}")
    print(f"  AUC (fold mean)  : {res['auc_fold_mean']:.3f} ± {res['auc_fold_std']:.3f}")
    print(f"  Recall@90%Spec   : {res['recall_at_90spec']:.3f}")
    print(f"  KPI (MCI AUC≥0.74): {'PASS' if res['auc_oof']>=0.74 else 'MISS'}")

    # 피처 중요도 (전체 학습)
    model = make_xgb().fit(X, y)
    imp = model.feature_importances_
    order = np.argsort(imp)[::-1][:12]
    print("\n  top features:")
    for i in order:
        print(f"    {names[i]:28s} {imp[i]:.3f}")

    print(f"\n  elapsed: {time.time()-t0:.1f}s")

    Path("data").mkdir(exist_ok=True)
    with open("data/kang_baseline_result.json", "w") as f:
        json.dump({k: v for k, v in res.items() if k != "oof_scores"}, f, indent=2)


if __name__ == "__main__":
    main()
