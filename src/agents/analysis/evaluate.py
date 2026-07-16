"""평가 하니스 — subject-level CV, AUC + Recall@90%Spec.

CLAUDE.md §5 KPI: MCI AUC ≥ 0.74, Recall@90%Spec ≥ 0.60.
§12: subject-level split 필수 (화자 leakage 방지). Kang은 파일=화자라 파일 단위 = subject 단위.
"""
from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold


def recall_at_spec(y_true: np.ndarray, y_score: np.ndarray, spec: float = 0.90) -> float:
    """지정 특이도에서의 민감도(recall). y_true: 1=양성(MCI/AD)."""
    neg = y_score[y_true == 0]
    if len(neg) == 0:
        return 0.0
    thr = np.quantile(neg, spec)          # neg의 spec 분위수 → 그 위를 양성 예측
    pred = y_score >= thr
    pos = y_true == 1
    return float((pred & pos).sum() / pos.sum()) if pos.sum() else 0.0


def cross_validate(model_factory, X: np.ndarray, y: np.ndarray, n_splits: int = 5, seed: int = 42) -> dict:
    """StratifiedKFold. 각 fold 독립 학습 → OOF 확률로 AUC/Recall 계산.

    Kang은 파일 하나가 화자 하나라 행=subject → StratifiedKFold가 곧 subject-level split.
    """
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    oof = np.zeros(len(y))
    fold_aucs = []
    for tr, te in skf.split(X, y):
        model = model_factory()
        model.fit(X[tr], y[tr])
        p = model.predict_proba(X[te])[:, 1]
        oof[te] = p
        if len(set(y[te])) > 1:
            fold_aucs.append(roc_auc_score(y[te], p))
    return {
        "auc_oof": float(roc_auc_score(y, oof)),
        "auc_fold_mean": float(np.mean(fold_aucs)),
        "auc_fold_std": float(np.std(fold_aucs)),
        "recall_at_90spec": recall_at_spec(y, oof, 0.90),
        "oof_scores": oof,
    }
