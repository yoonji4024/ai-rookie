"""Kang 코퍼스(.cha + .wav) 로더.

DementiaBank Kang (한국어 인터뷰): data/Kang/{HC,MCI}/NN.{cha,wav}
- HC = Control, MCI = ProbableMCI
- .cha: CHAT 포맷. *PAR/*INV 발화 + 끝에 `start_end` (ms) 타임스탬프.
- .wav: 16kHz mono.

사용:
    from src.preprocessing.kang_loader import load_kang
    records = load_kang("data/Kang")   # list[KangRecord]
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

TIMESTAMP_RE = re.compile(r"\x15?(\d+)_(\d+)\x15?\s*$")
CLEAN_RE = re.compile(
    r"&[-+=]?[^\s]+"      # &-음 (filled pause 마커) 등 CHAT 코드
    r"|\[[^\]]*\]"        # [...] 주석/코드
    r"|<|>"               # retracing 괄호
    r"|\+[^\s]+"          # +... 코드
    r"|\(\.+\)"           # (.) 휴지 마커
)


@dataclass
class Utterance:
    speaker: str            # "PAR" | "INV"
    text: str               # 정제된 텍스트
    raw: str                # 원본 (disfluency 마커 보존)
    start_ms: int | None
    end_ms: int | None


@dataclass
class KangRecord:
    subject_id: str         # 예: "HC_01"
    label: str              # "HC" | "MCI"
    age: int | None
    sex: str | None
    cha_path: str
    wav_path: str
    utterances: list[Utterance] = field(default_factory=list)

    @property
    def par_utterances(self) -> list[Utterance]:
        return [u for u in self.utterances if u.speaker == "PAR"]

    @property
    def par_text(self) -> str:
        """참가자 발화 전체 (언어 피처 입력)."""
        return " ".join(u.text for u in self.par_utterances if u.text)

    @property
    def word_timings(self) -> list[dict]:
        """발화 단위 타이밍 (extract_linguistic 인터페이스용)."""
        return [
            {"text": u.text, "startTime": u.start_ms / 1000, "endTime": u.end_ms / 1000}
            for u in self.par_utterances
            if u.start_ms is not None and u.end_ms is not None
        ]


def _parse_id_line(line: str) -> tuple[int | None, str | None]:
    # @ID: kor|Kang|PAR|67;|female|Control||Participant|||
    parts = line.split("|")
    age = sex = None
    if len(parts) > 4:
        m = re.match(r"(\d+)", parts[3])
        age = int(m.group(1)) if m else None
        sex = parts[4] or None
    return age, sex


def _clean_text(raw: str) -> str:
    t = CLEAN_RE.sub(" ", raw)
    t = re.sub(r"[^\w\s가-힣?.!,]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def parse_cha(cha_path: Path) -> tuple[list[Utterance], int | None, str | None]:
    age, sex = None, None
    utterances: list[Utterance] = []
    cur_speaker, cur_line = None, ""

    def flush():
        nonlocal cur_speaker, cur_line
        if cur_speaker is None:
            return
        m = TIMESTAMP_RE.search(cur_line)
        start_ms = end_ms = None
        body = cur_line
        if m:
            start_ms, end_ms = int(m.group(1)), int(m.group(2))
            body = cur_line[: m.start()]
        utterances.append(
            Utterance(cur_speaker, _clean_text(body), body.strip(), start_ms, end_ms)
        )
        cur_speaker, cur_line = None, ""

    for line in cha_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("@ID:") and "|PAR|" in line:
            age, sex = _parse_id_line(line)
        elif line.startswith("*"):
            flush()
            speaker, _, rest = line[1:].partition(":")
            cur_speaker, cur_line = speaker.strip(), rest.strip()
        elif line.startswith("\t") and cur_speaker:  # 발화 연속행
            cur_line += " " + line.strip()
        elif line.startswith("%") or line.startswith("@"):
            flush()
    flush()
    return utterances, age, sex


def load_kang(root: str | Path = "data/Kang", labels: tuple[str, ...] = ("HC", "MCI")) -> list[KangRecord]:
    root = Path(root)
    records = []
    for label in labels:
        for cha in sorted((root / label).glob("*.cha")):
            wav = cha.with_suffix(".wav")
            if not wav.exists():
                continue
            utts, age, sex = parse_cha(cha)
            records.append(
                KangRecord(
                    subject_id=f"{label}_{cha.stem}",
                    label=label,
                    age=age,
                    sex=sex,
                    cha_path=str(cha),
                    wav_path=str(wav),
                    utterances=utts,
                )
            )
    return records


if __name__ == "__main__":
    recs = load_kang()
    print(f"loaded {len(recs)} records")
    for lab in ("HC", "MCI"):
        subset = [r for r in recs if r.label == lab]
        n_utt = sum(len(r.par_utterances) for r in subset)
        print(f"  {lab}: {len(subset)} subjects, {n_utt} PAR utterances")
    r = recs[0]
    print(r.subject_id, r.age, r.sex, "| sample:", r.par_utterances[0].text[:50])
