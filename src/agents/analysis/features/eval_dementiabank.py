"""DementiaBank 교차언어 음향 검증 — Pitt(영)·Delaware(영)·Lu(중) 통합.

목적
  Kang(한국어)에서 확인한 음향 지표가 영어·중국어에서도 정상 vs 치매를
  가르는가. 언어가 달라도 유효하면 지표가 언어 독립적이라는 근거.

  ⚠️ 언어 피처(한국어 형태소·krr_*) 제외 — **음향 51개만**.
  ⚠️ 화자 단위 CV (StratifiedGroupKFold). 종단·복수과제라 leakage 방지 필수.

라벨: dementiabank_labels.csv(@ID) 기반. 0 정상 / 1 MCI / 2 치매.
  기본 검증은 정상 vs 치매(MCI 제외). Delaware는 MCI vs 정상도 별도 리포트.

사용:
    python3 -m src.agents.analysis.features.eval_dementiabank
    python3 -m src.agents.analysis.features.eval_dementiabank --corpora Pitt Delaware Lu
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from src.agents.analysis.classifier import make_xgb
from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.preprocessing.dementiabank_loader import load_dementiabank

# Kang에서 검증된 주력 음향 지표 (방향 비교용)
VOICE_KEYS = ["ac_hnr", "ac_cpp", "ac_shimmer_local", "ac_jitter_local",
              "ac_f0_mean", "ac_pause_ratio", "ac_voiced_seg_rate"]

# 피처 캐시 — mp3_path별 벡터를 append. 중단·재실행에 강건
CACHE = Path("data/dementiabank_en_features.csv")


def _load_cache() -> tuple[dict[str, np.ndarray], list[str] | None]:
    """{mp3_path: vec}, feature_names. 없으면 ({}, None)."""
    if not CACHE.exists():
        return {}, None
    cache, names = {}, None
    with open(CACHE, newline="", encoding="utf-8") as fh:
        rd = csv.reader(fh)
        header = next(rd, None)
        if not header:
            return {}, None
        names = header[1:]                       # 0번은 mp3_path
        for row in rd:
            if len(row) == len(header):
                cache[row[0]] = np.array([float(x) for x in row[1:]])
    return cache, names


def _append_cache(mp3_path: str, vec: np.ndarray, names: list[str]) -> None:
    new = not CACHE.exists()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["mp3_path"] + list(names))
        w.writerow([mp3_path] + [f"{v:.6g}" for v in vec])


def _cv_auc(X, y, groups, n_splits=5):
    """화자 단위 OOF AUC. 그룹 수 부족하면 splits 축소."""
    ng = len(set(groups))
    k = min(n_splits, ng, int(min(np.bincount(y))))
    if k < 2:
        return float("nan")
    sgkf = StratifiedGroupKFold(n_splits=k, shuffle=True, random_state=42)
    oof = np.zeros(len(y))
    for tr, te in sgkf.split(X, y, groups):
        m = make_xgb().fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
    return roc_auc_score(y, oof)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpora", nargs="+", default=["Pitt", "Delaware", "Lu"])
    ap.add_argument("--pitt-task", default="cookie")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--vad-mode", default="none", choices=["none", "hybrid", "all"],
                    help="none=원본(기존 0.765 기준) / hybrid=휴지는원본·음질은발화구간 / all=전면VAD")
    a = ap.parse_args()
    vad_mode = a.vad_mode
    # 모드별로 캐시를 분리한다. 섞이면 이전 모드의 피처를 재사용해 비교가 무의미해진다.
    global CACHE
    if vad_mode != "none":
        CACHE = CACHE.with_name(f"dementiabank_en_features_{vad_mode}.csv")
    print(f"[VAD 모드: {vad_mode}]  캐시: {CACHE.name}")

    recs = load_dementiabank(a.corpora, pitt_task=a.pitt_task)
    if a.limit:
        recs = recs[: a.limit]
    print(f"로드 {len(recs)}건 / 화자 {len({r.speaker_id for r in recs})}명. 음향 추출 시작…")

    # 피처 캐시: 계산 즉시 CSV에 append → 중단돼도 진행 보존, 재실행 시 즉시 이어감
    cache, cache_names = _load_cache()
    if cache:
        print(f"  캐시 {len(cache)}건 재사용")

    rows = []  # (corpus, speaker, label3, vec)
    names = cache_names
    done = 0
    for i, r in enumerate(recs, 1):
        if r.mp3_path in cache:
            vec = cache[r.mp3_path]
        else:
            try:
                ac = extract_acoustic(r.mp3_path, vad_mode=vad_mode)
                vec, names = build_feature_vector(ac, {})
            except Exception as e:            # 깨진 파일 하나가 전체를 막지 않게
                print(f"  ! 스킵 {r.mp3_path}: {e}")
                continue
            _append_cache(r.mp3_path, vec, names)
            done += 1
        rows.append((r.corpus, r.speaker_id, r.label3, vec))
        if i % 100 == 0:
            print(f"  피처 {i}/{len(recs)} (신규 {done})")

    ac_idx = [i for i, n in enumerate(names) if n.startswith("ac_")]
    names = [names[i] for i in ac_idx]
    idx = {n: i for i, n in enumerate(names)}

    corpus = np.array([r[0] for r in rows])
    spk = np.array([r[1] for r in rows])
    lab3 = np.array([r[2] for r in rows])
    X = np.vstack([r[3] for r in rows])[:, ac_idx]

    def report(mask, pos_lab, title):
        """mask 안에서 정상(0) vs pos_lab 이진 분류 리포트."""
        sub = mask & np.isin(lab3, [0, pos_lab])
        if sub.sum() < 10:
            print(f"  {title}: 표본 부족 ({sub.sum()})")
            return
        Xs, gs = X[sub], spk[sub]
        ys = (lab3[sub] == pos_lab).astype(int)
        n0, n1 = int((ys == 0).sum()), int((ys == 1).sum())
        auc = _cv_auc(Xs, ys, gs)
        print(f"  {title:26s} 정상 {n0:3d} / 양성 {n1:3d} · 화자 {len(set(gs)):3d} · AUC {auc:.3f}")

    print("\n── 코퍼스별 정상 vs 치매 (화자 단위 5-fold, 음향만) ──")
    for c in a.corpora:
        report(corpus == c, 2, f"{c} 정상vs치매")
    print("\n── Delaware MCI vs 정상 (조기 신호) ──")
    report(corpus == "Delaware", 1, "Delaware 정상vsMCI")

    print("\n── 통합(전 코퍼스) 정상 vs 치매 ──")
    report(np.ones(len(X), bool), 2, "POOLED 정상vs치매")

    # 방향 비교표 (정상 vs 치매 평균) — Kang과 부호 일치 확인용
    print("\n── 주요 음향 지표 방향 (통합, 정상 vs 치매) ──")
    m = np.isin(lab3, [0, 2])
    yb = (lab3[m] == 2).astype(int)
    for k in VOICE_KEYS:
        if k not in idx:
            continue
        col = X[m][:, idx[k]]
        au = roc_auc_score(yb, col)
        au = max(au, 1 - au)
        print(f"   {k:20s} 정상 {col[yb==0].mean():8.3f} | 치매 {col[yb==1].mean():8.3f} | AUC {au:.3f}")


if __name__ == "__main__":
    main()
