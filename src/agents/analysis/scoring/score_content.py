"""내용(semantic) 5축 스코어링 엔진.

두 종류의 축을 함께 다룬다 (rubric_content.py 참조).
  [A] 전사 기반 — HC 규준 z 점수. 발화 축과 동일 방식, Kang으로 검증됨.
  [B] 회상 기반 — 이벤트 그래프 정답 대비 직접 환산. 객관적이나 MCI 판별력은 미검증.

⚠️ 두 종류를 한 총점으로 합칠 때, **검증된 축과 미검증 축이 섞인다는 점**을 리포트에
   명시해야 한다. 총점만 보고 "검증된 성능"으로 오해하면 안 된다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.stats import norm

from src.agents.analysis.scoring.rubric_content import (
    AXES_TRANSCRIPT, AXIS_WEIGHTS, RECALL_AXES, Z_CLIP, Z_SHIFT,
    grade_of, score_context_match, score_memory_accuracy,
)


@dataclass
class ContentScoringModel:
    """전사 기반 축용 HC 참조분포 + 방향."""

    feature_names: list[str]
    hc_mean: dict[str, float] = field(default_factory=dict)
    hc_std: dict[str, float] = field(default_factory=dict)
    direction: dict[str, float] = field(default_factory=dict)

    @classmethod
    def fit(cls, X: np.ndarray, y: np.ndarray, feature_names: list[str]) -> "ContentScoringModel":
        m = cls(feature_names=list(feature_names))
        idx = {n: i for i, n in enumerate(feature_names)}
        hc, mci = X[y == 0], X[y == 1]
        for members in AXES_TRANSCRIPT.values():
            for f in members:
                if f not in idx or f in m.hc_mean:
                    continue
                i = idx[f]
                hc_col = hc[:, i]
                mci_col = mci[:, i]
                hc_valid = hc_col[np.isfinite(hc_col)]
                mci_valid = mci_col[np.isfinite(mci_col)]
                if len(hc_valid) == 0:
                    continue
                mu = float(hc_valid.mean())
                sd = float(hc_valid.std())
                mci_mu = float(mci_valid.mean()) if len(mci_valid) else mu
                m.hc_mean[f] = mu
                m.hc_std[f] = sd if sd > 1e-12 else 1.0
                # 방향은 데이터가 정한다 (직관 아님)
                m.direction[f] = 1.0 if mu >= mci_mu else -1.0
        return m

    # ── 저장 / 로드 ─────────────────────────────────────────
    # 참조분포만 담으면 되므로 JSON으로 충분. 서빙 시 재학습하지 않기 위해 필요.
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
    def load(cls, path: str) -> "ContentScoringModel":
        import json
        d = json.loads(open(path, encoding="utf-8").read())
        return cls(feature_names=d["feature_names"], hc_mean=d["hc_mean"],
                   hc_std=d["hc_std"], direction=d["direction"])

    def score_transcript_axes(self, x: np.ndarray) -> dict:
        idx = {n: i for i, n in enumerate(self.feature_names)}
        out = {}
        for axis, members in AXES_TRANSCRIPT.items():
            usable = [f for f in members if f in self.hc_mean and f in idx]
            if not usable:
                continue
            zs, detail, missing = [], {}, []
            for f in usable:
                raw = float(x[idx[f]])
                if (not np.isfinite(raw)
                        or not np.isfinite(self.hc_mean[f])
                        or not np.isfinite(self.hc_std[f])):
                    missing.append(f)
                    continue
                z = float(np.clip((raw - self.hc_mean[f]) / self.hc_std[f] * self.direction[f],
                                  -Z_CLIP, Z_CLIP))
                zs.append(z)
                detail[f] = {"value": round(raw, 4), "hc_mean": round(self.hc_mean[f], 4),
                             "z": round(z, 3)}
            if not zs:
                out[axis] = {"score": None, "z": None, "features": {},
                             "missing": missing, "validated": True}
                continue
            az = float(np.mean(zs))
            out[axis] = {"score": _z_to_score(az), "z": round(az, 3),
                         "features": detail, "validated": True}
            if missing:
                out[axis]["missing"] = missing
        if "시간·장소 지남력" in out:
            # Identify this newly computed source explicitly. Do not infer it
            # later from an old report's score or label alone.
            out["시간·장소 지남력"]["measurement_source"] = "transcript_expression_reference"
        return out

    def score_all(self, x: np.ndarray, recall: dict | None = None,
                  n_scenes: int = 0) -> dict:
        """전사 축 + (있으면) 회상 축 → 내용 총점."""
        axes = self.score_transcript_axes(x)

        if recall:
            s, d = score_memory_accuracy(recall)
            axes["기억 정확도"] = {"score": s, "detail": d, "validated": False}
            s, d = score_context_match(recall, n_scenes)
            axes["문맥 일치도"] = {"score": s, "detail": d, "validated": False}

        total = _weighted_total(axes)
        return {
            "axes": axes,
            "total_score": total,
            "grade": grade_of(total) if total is not None else "측정 불가",
            "weakest": [a for a, _ in sorted(
                ((a, v) for a, v in axes.items() if v.get("score") is not None),
                key=lambda kv: kv[1]["score"],
            )[:2]],
            "note": ("전사 기반 축은 Kang으로 검증됨. 회상 기반 축(기억 정확도·문맥 일치도)은 "
                     "객관적 정답 대비 산출이나 MCI 판별력은 미검증."),
        }


def _z_to_score(z: float) -> int:
    return int(round(100 * float(norm.cdf(z + Z_SHIFT))))


def _weighted_total(axes: dict) -> int | None:
    valid = {k: a for k, a in axes.items() if a.get("score") is not None}
    if not valid:
        return None
    num = sum(a["score"] * AXIS_WEIGHTS.get(k, 1.0) for k, a in valid.items())
    den = sum(AXIS_WEIGHTS.get(k, 1.0) for k in valid)
    return int(round(num / den))


if __name__ == "__main__":
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import StratifiedKFold

    d = np.load("data/kang_features.npz", allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]

    have = [f for m in AXES_TRANSCRIPT.values() for f in m if f in names]
    print(f"루브릭 피처 {sum(len(m) for m in AXES_TRANSCRIPT.values())}개 중 캐시에 존재: {len(have)}개")
    missing = [f for m in AXES_TRANSCRIPT.values() for f in m if f not in names]
    if missing:
        print(f"⚠️ 없음(캐시 재생성 필요): {missing}\n")

    # 전사 축만 leakage 없이 검증
    skf = StratifiedKFold(5, shuffle=True, random_state=42)
    per_axis = {a: np.zeros(len(y)) for a in AXES_TRANSCRIPT}
    total = np.zeros(len(y))
    for tr, te in skf.split(X, y):
        m = ContentScoringModel.fit(X[tr], y[tr], names)
        for i in te:
            r = m.score_all(X[i])
            total[i] = r["total_score"]
            for a, v in r["axes"].items():
                per_axis[a][i] = v["score"]

    print("내용 축 판별력 (전사 기반만, OOF·leakage 차단)")
    for a, s in per_axis.items():
        if s.any():
            print(f"  {a:16s} HC {s[y==0].mean():5.1f} | MCI {s[y==1].mean():5.1f} "
                  f"| AUC {roc_auc_score(y, -s):.3f}")
    print(f"\n  전사축 총점    HC {total[y==0].mean():5.1f} | MCI {total[y==1].mean():5.1f} "
          f"| AUC {roc_auc_score(y, -total):.3f}")
