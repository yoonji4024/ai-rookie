"""탐지 분류기 — XGBoost (기본), MLP (GPU Live 실험용).

predict() 인터페이스는 CLAUDE.md §9 고정.
"""
from __future__ import annotations

import numpy as np


def make_xgb(**kw):
    from xgboost import XGBClassifier

    params = dict(
        n_estimators=300,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        eval_metric="logloss",
        random_state=42,
    )
    params.update(kw)
    return XGBClassifier(**params)


class Classifier:
    """스케일러 + XGBoost 래퍼. predict()로 §9 스키마 반환."""

    LABELS = ["normal", "MCI", "AD"]

    def __init__(self, feature_names: list[str] | None = None, positive_label: str = "MCI"):
        self.feature_names = feature_names
        self.positive_label = positive_label
        self.model = make_xgb()

    def fit(self, X, y):
        self.model.fit(X, y)
        return self

    def predict(self, features) -> dict:
        """{'label', 'prob', 'top_features'} — §9 시그니처."""
        x = np.asarray(features, dtype=np.float64).reshape(1, -1)
        p1 = float(self.model.predict_proba(x)[0, 1])
        label = self.positive_label if p1 >= 0.5 else "normal"
        top = self._top_features()
        return {
            "label": label,
            "prob": {"normal": 1 - p1, self.positive_label: p1},
            "top_features": top,
        }

    def _top_features(self, k: int = 5) -> list[str]:
        if self.feature_names is None:
            return []
        imp = self.model.feature_importances_
        idx = np.argsort(imp)[::-1][:k]
        return [self.feature_names[i] for i in idx]
