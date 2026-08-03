"""서빙용 참조분포 저장 — 학습 데이터 없이 API가 채점할 수 있게 한다.

API 서버가 요청마다 재학습할 수 없고, 배포 환경에는 실데이터를 두지 않는다.
따라서 학습은 여기서 한 번만 하고, 결과(HC 평균·표준편차·피처 방향)만
JSON으로 떨어뜨려 서버가 로드한다.

⚠️ 저장되는 것은 **집단 통계값뿐**이다. 개인 음성·전사는 들어가지 않는다.
   그래도 파생 정보이므로 공개 레포에 커밋하지 말 것 (.gitignore 확인).

사용 (서버, 실데이터 있는 곳):
    python3 -m src.api.build_model
    → configs/scoring_model.json
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

OUT = Path("configs/scoring_model.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--out-content", default="configs/scoring_model_content.json")
    a = ap.parse_args()

    from src.agents.analysis.features.build_vector import build_feature_vector
    from src.agents.analysis.features.extract_acoustic import extract_acoustic
    from src.agents.analysis.scoring.score import ScoringModel
    from src.preprocessing.kang_loader import load_kang

    recs = load_kang()
    print(f"DementiaBank Korean {len(recs)}명 — 피처 추출")

    X, y, names = [], [], None
    for i, r in enumerate(recs, 1):
        segs = [(w["startTime"], w["endTime"]) for w in r.word_timings]
        ac = extract_acoustic(r.wav_path, segments=segs or None)
        try:
            from src.agents.analysis.features.extract_linguistic import extract_linguistic
            lg = extract_linguistic(r.par_text, r.word_timings)
        except Exception:
            lg = {}
        vec, names = build_feature_vector(ac, lg)
        X.append(vec)
        y.append(0 if r.label == "HC" else 1)
        if i % 20 == 0:
            print(f"  {i}/{len(recs)}")

    X, y = np.vstack(X), np.array(y)
    print(f"HC {int((y==0).sum())} / MCI {int((y==1).sum())}, 피처 {len(names)}")

    m = ScoringModel.fit(X, y, names)
    m.save(a.out)
    print(f"저장: {a.out}  (발화 참조분포 {len(m.hc_mean)}개 피처)")

    # 방향이 직관과 반대인 피처 — 설계 근거로 자주 인용되므로 같이 출력
    neg = [f for f, d in m.direction.items() if d < 0]
    print(f"'낮을수록 정상'으로 학습된 피처 {len(neg)}개: {neg[:8]}")

    # 내용 축(전사 기반 3축)도 같은 데이터로 참조분포를 만든다.
    # 회상 기반 2축(문맥 일치도·기억 정확도)은 이벤트 그래프 정답 대비 직접 환산하므로
    # 참조분포가 필요 없다 → 런타임에 recall 결과로 계산.
    from src.agents.analysis.scoring.score_content import ContentScoringModel
    cm = ContentScoringModel.fit(X, y, names)
    cm.save(a.out_content)
    print(f"저장: {a.out_content}  (내용 참조분포 {len(cm.hc_mean)}개 피처)")


if __name__ == "__main__":
    main()
