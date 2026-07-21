"""보호자용 리포트 샘플 생성 — 점수대별(정상/위험/심각) 실제 출력 확인용.

터미널 한글 깨짐 대비로 마크다운 파일에도 저장한다.

사용:
    python3 -m src.agents.analysis.scoring.demo_report
    → docs/샘플_리포트.md 생성
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from src.agents.analysis.scoring.report_solar import generate_speech_report_verified
from src.agents.analysis.scoring.score import ScoringModel

CACHE = Path("data/kang_features.npz")
OUT = Path("docs/샘플_리포트.md")


def pick_samples(totals: np.ndarray) -> dict[str, int]:
    """정상·위험·심각 대역에서 각 1명씩 (없으면 최고/중앙/최저)."""
    order = np.argsort(totals)          # 낮은 순
    return {
        "심각(최저점)": int(order[0]),
        "위험(중앙값)": int(order[len(order) // 2]),
        "정상(최고점)": int(order[-1]),
    }


def main():
    if not CACHE.exists():
        raise SystemExit("캐시 없음 — 먼저 run_kang_baseline 실행")
    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    ids = [str(i) for i in d["ids"]] if "ids" in d else [str(i) for i in range(len(y))]

    model = ScoringModel.fit(X, y, names)
    totals = model.total_scores(X)

    lines = [
        "# 보호자용 리포트 샘플 (Solar Pro 2 생성)",
        "",
        "> 점수·등급은 규칙 기반으로 산출하고, **모든 문장은 Solar가 생성**한다.",
        "> 검증 통과(스키마·근거성·진단단정 금지) 후의 출력만 수록.",
        "",
    ]

    for label, idx in pick_samples(totals).items():
        sr = model.score_one(X[idx])
        truth = "MCI" if y[idx] == 1 else "HC"
        print(f"\n[{label}] {ids[idx]} — 총점 {sr['total_score']} ({sr['grade']}), 실제 {truth}")
        rep = generate_speech_report_verified(sr)

        lines += [
            f"## {label} — {ids[idx]}",
            "",
            f"- 총점 **{sr['total_score']}점** · 등급 **{sr['grade']}** · (실제 라벨: {truth})",
            "- 축별 점수: " + ", ".join(f"{a} {v['score']}" for a, v in sr["axes"].items()),
            f"- 검증: {'통과' if rep.get('_verified') else '미통과'} (시도 {rep.get('_attempts', '?')}회)",
            "",
            "**요약**",
            "",
            f"> {rep.get('summary', '(생성 실패)')}",
            "",
            "**축별 코멘트**",
            "",
        ]
        for a, c in rep.get("axis_comments", {}).items():
            lines.append(f"- **{a}**: {c}")
        lines += [
            "",
            "**권고**",
            "",
            f"> {rep.get('recommendation', '')}",
            "",
            "---",
            "",
        ]
        print(f"  요약: {rep.get('summary', '')[:60]}...")

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n저장 완료: {OUT}  (한글 깨짐 없이 이 파일에서 확인)")


if __name__ == "__main__":
    main()
