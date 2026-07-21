"""mp4 → wav 추출 (ffmpeg) — 기존 음향 파이프라인에 연결.

Kang과 동일 규격(16kHz mono)으로 뽑아야 extract_acoustic을 그대로 쓸 수 있다.

사용:
    python3 -m src.event_graph.extract_audio          # Sample 전체 추출
    python3 -m src.event_graph.extract_audio --demo   # 추출 + 음향 피처 확인
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from src.event_graph.sample_loader import load_all

OUT_DIR = Path("data/Sample/audio")
SR = 16000


def extract(video_path: str | Path, out_path: str | Path, sr: int = SR) -> Path:
    """mp4 → 16kHz mono wav."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(video_path),
        "-vn",                    # 영상 제거
        "-ac", "1",               # mono
        "-ar", str(sr),           # 16kHz
        "-f", "wav", str(out_path),
    ]
    subprocess.run(cmd, check=True)
    return out_path


def extract_all(out_dir: str | Path = OUT_DIR) -> dict[str, Path]:
    """Sample 전체 mp4 → wav. {content_id: wav_path}"""
    out_dir = Path(out_dir)
    made = {}
    for g in load_all():
        if not g.video_path:
            print(f"  [skip] {g.content_id}: 영상 없음")
            continue
        wav = out_dir / f"{g.content_id}.wav"
        if wav.exists():
            print(f"  [skip] {g.content_id}: 이미 있음")
        else:
            extract(g.video_path, wav)
            print(f"  [ok] {g.content_id} → {wav.name}")
        made[g.content_id] = wav
    return made


def speaker_segments(graph, speaker_id: int | None = None) -> list[tuple[float, float]]:
    """전사에서 (start, end) 구간 목록 — extract_acoustic의 segments 인자용.

    speaker_id를 주면 해당 화자만 (런타임에선 어르신 화자만 골라 쓰는 용도).
    """
    return [
        (t["start"], t["end"])
        for t in graph.transcript
        if speaker_id is None or t.get("speaker_id") == speaker_id
    ]


def main():
    print("mp4 → wav 추출")
    made = extract_all()
    print(f"\n완료: {len(made)}개")

    if "--demo" in sys.argv:
        from src.agents.analysis.features.extract_acoustic import extract_acoustic

        print("\n음향 피처 추출 데모 (전사 구간 기준)")
        for g in load_all():
            wav = made.get(g.content_id)
            if not wav or not Path(wav).exists():
                continue
            segs = speaker_segments(g)
            ac = extract_acoustic(str(wav), segments=segs)
            print(f"  [{g.category}] {g.content_id}: 피처 {len(ac)}개 | "
                  f"발화 {len(segs)}구간 | pause_ratio={ac['pause_ratio']:.3f} "
                  f"speech_dur={ac['total_speech_dur']:.0f}s")


if __name__ == "__main__":
    main()
