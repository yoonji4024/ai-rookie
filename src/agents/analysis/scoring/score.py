"""규칙 기반 발화 스코어링 엔진.

피처 벡터 → 축별 0~100점 + 총점 + 등급.

핵심: 참조분포(HC 평균/표준편차)와 피처 방향(부호)을 **학습 데이터에서 적합(fit)** 한 뒤
      새 화자에 적용(transform). 검증 시 fold 내부에서만 fit해 leakage를 막는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.stats import norm

from src.agents.analysis.scoring.rubric import (
    AXES, AXIS_WEIGHTS, EXCLUDED_FEATURES, Z_CLIP, Z_SHIFT, grade_of,
)


@dataclass
class ScoringModel:
    """HC 참조분포 + 피처 방향을 담은 스코어링 모델."""

    feature_names: list[str]
    hc_mean: dict[str, float] = field(default_factory=dict)
    hc_std: dict[str, float] = field(default_factory=dict)
    direction: dict[str, float] = field(default_factory=dict)   # +1: 값↑ = 정상, -1: 값↓ = 정상

    # ── fit ────────────────────────────────────────────────
    @classmethod
    def fit(cls, X: np.ndarray, y: np.ndarray, feature_names: list[str]) -> "ScoringModel":
        """X: (n, d) 피처행렬, y: 0=HC, 1=MCI.

        - 참조분포: HC 집단의 평균/표준편차
        - 방향: HC 평균 > MCI 평균이면 +1 (값이 클수록 정상), 아니면 -1
          → 직관이 아니라 **데이터가 방향을 정한다** (rubric.py 설계원칙 1)
        """
        m = cls(feature_names=list(feature_names))
        idx = {n: i for i, n in enumerate(feature_names)}
        hc, mci = X[y == 0], X[y == 1]
        for f in _rubric_features(feature_names):
            i = idx[f]
            mu, sd = float(hc[:, i].mean()), float(hc[:, i].std())
            m.hc_mean[f] = mu
            m.hc_std[f] = sd if sd > 1e-12 else 1.0
            m.direction[f] = 1.0 if hc[:, i].mean() >= mci[:, i].mean() else -1.0
        return m

    # ── transform ──────────────────────────────────────────
    def score_one(self, x: np.ndarray) -> dict:
        """한 화자의 피처 벡터 → 점수 딕셔너리."""
        idx = {n: i for i, n in enumerate(self.feature_names)}
        axes_out: dict[str, dict] = {}

        for axis, members in AXES.items():
            usable = [f for f in members
                      if f in self.hc_mean and f in idx and f not in EXCLUDED_FEATURES]
            if not usable:
                continue
            zs, detail, missing = [], {}, []
            for f in usable:
                raw = float(x[idx[f]])
                # 계산 불가(NaN)는 **결측**이다. 0으로 취급하면 z=-8 같은 값이 생겨
                # 추출 실패가 병리 신호로 둔갑한다 → 축 평균에서 제외한다.
                if not np.isfinite(raw):
                    missing.append(f)
                    continue
                z = (raw - self.hc_mean[f]) / self.hc_std[f] * self.direction[f]
                z = float(np.clip(z, -Z_CLIP, Z_CLIP))
                zs.append(z)
                detail[f] = {
                    "value": round(raw, 4),
                    "hc_mean": round(self.hc_mean[f], 4),
                    "z": round(z, 3),
                    "direction": "높을수록 정상" if self.direction[f] > 0 else "낮을수록 정상",
                }
            if not zs:
                # 축 전체가 결측이면 점수를 만들지 않는다(0점으로 두면 오해를 부른다).
                axes_out[axis] = {"score": None, "z": None, "features": {},
                                  "missing": missing}
                continue
            az = float(np.mean(zs))
            axes_out[axis] = {
                "score": _z_to_score(az),
                "z": round(az, 3),
                "features": detail,
            }
            if missing:
                axes_out[axis]["missing"] = missing

        total = _weighted_total(axes_out)
        return {
            "axes": axes_out,
            "total_score": total,
            "grade": grade_of(total),
            "weakest": _weakest(axes_out, k=2),
        }

    def score_many(self, X: np.ndarray) -> list[dict]:
        return [self.score_one(x) for x in X]

    # ── 저장 / 로드 ─────────────────────────────────────────
    # 참조분포(HC 평균·표준편차·방향)만 담으면 되므로 JSON으로 충분하다.
    # 서빙 시 매번 재학습하지 않기 위해 필요. 학습 데이터 없이 배포 가능.
    def save(self, path: str) -> None:
        import json
        from pathlib import Path
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({
            "feature_names": self.feature_names,
            "hc_mean": self.hc_mean,
            "hc_std": self.hc_std,
            "direction": self.direction,
        }, ensure_ascii=False, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: str) -> "ScoringModel":
        import json
        d = json.loads(open(path, encoding="utf-8").read())
        return cls(feature_names=d["feature_names"], hc_mean=d["hc_mean"],
                   hc_std=d["hc_std"], direction=d["direction"])

    def total_scores(self, X: np.ndarray) -> np.ndarray:
        return np.array([r["total_score"] for r in self.score_many(X)], dtype=float)


# ── helpers ────────────────────────────────────────────────
def _rubric_features(feature_names: list[str]) -> list[str]:
    avail = set(feature_names)
    out = []
    for members in AXES.values():
        for f in members:
            if f in avail and f not in EXCLUDED_FEATURES and f not in out:
                out.append(f)
    return out


def _z_to_score(z: float) -> int:
    """z → 0~100점. 100·Φ(z + Z_SHIFT): HC 평균(z=0) ≈ 84점, -1SD ≈ 50점."""
    return int(round(100 * float(norm.cdf(z + Z_SHIFT))))


def _weighted_total(axes_out: dict) -> int:
    """결측 축(score=None)은 총점 계산에서 제외한다."""
    valid = {a: v for a, v in axes_out.items() if v.get("score") is not None}
    if not valid:
        return 0
    num = sum(valid[a]["score"] * AXIS_WEIGHTS.get(a, 1.0) for a in valid)
    den = sum(AXIS_WEIGHTS.get(a, 1.0) for a in valid)
    return int(round(num / den))


def _weakest(axes_out: dict, k: int = 2) -> list[str]:
    valid = [(a, v) for a, v in axes_out.items() if v.get("score") is not None]
    return [a for a, _ in sorted(valid, key=lambda kv: kv[1]["score"])[:k]]
