// ============================================================================
// 언제 끼어들 것인가.
//
// 예전 플레이어(DramaScenePlayer)의 판정은 `t >= q.timestamp` 였다. 세 가지가 잘못됐다.
//   1. 진행 바를 20초로 옮기면 15초 질문이 즉시 터진다 (건너뛴 구간을 소비하지 않음)
//   2. 정렬 배열을 매 렌더 새로 만들어 useCallback 이 사실상 무효화됐다
//   3. 광고 구간을 구분하지 못한다
//
// 여기서는 "커서"를 둔다. 커서는 실제로 판정을 마친 마지막 위치다.
// 매 pulse 마다 (커서, 지금] 구간을 평가하고, 판정을 건너뛴 tick 에서는 커서를 옮기지 않는다.
// 그래야 광고나 전체화면 때문에 보류한 구간이 조용히 삼켜지지 않는다.
// ============================================================================

import type { BeatCue } from "./types.ts";
import { cueKey } from "./types.ts";
import type { VideoPulse } from "../protocol.ts";
import { log } from "../obs/log.ts";

/**
 * 정상 재생으로 볼 수 있는 진행폭의 상한(초).
 * content script 가 150ms 마다 pulse 를 보내므로 2초면 넉넉하다.
 * 이보다 크게 벌어졌으면 seek 이거나 탭이 백그라운드였던 것이다.
 */
const MAX_NORMAL_STEP_SEC = 2;

/**
 * 전체화면이 풀렸을 때, 미뤄 둔 cue 를 되살릴 수 있는 최대 지연(초).
 *
 * 왜 필요한가: 사용자가 전체화면으로 10분을 보다가 빠져나왔는데 Pet 이 8분 전 장면을
 * 이야기하면 이상하다. 반대로 3초 전에 지나친 지점은 아직 "방금 그 장면"이다.
 * 그래서 이 창 안의 것 하나만 되살리고 나머지는 조용히 버린다.
 *
 * seek 에는 적용하지 않는다 — 사용자가 의도적으로 건너뛴 구간은 되살리면 안 된다.
 */
const RESUME_WINDOW_SEC = 12;

export interface CueScheduler {
  /** pulse 한 틱을 먹이면 이번 틱에 발화된 cue 를 돌려준다 */
  feed(pulse: VideoPulse): BeatCue[];
  /** 지금까지 소비된 cue 키 목록 (디버그·복원용) */
  consumedKeys(): string[];
  /** 발화 없이 소비 처리한다 */
  consume(cue: BeatCue): void;
  reset(): void;
}

export function createCueScheduler(cues: BeatCue[]): CueScheduler {
  // 정렬은 생성 시 한 번만 — 매 렌더 재생성되던 옛 병리를 옮겨오지 않는다
  const secondCues = cues
    .filter((c): c is Extract<BeatCue, { at: "seconds" }> => c.at === "seconds")
    .slice()
    .sort((a, b) => a.seconds - b.seconds);
  const hasEnded = cues.some((c) => c.at === "ended");
  const hasPausedByUser = cues.some((c) => c.at === "paused-by-user");

  const consumed = new Set<string>();
  /** 판정을 마친 마지막 본편 재생 위치. null 이면 아직 한 번도 평가하지 않았다 */
  let cursor: number | null = null;
  /** 전체화면 때문에 발화를 미뤄 둔 cue 들 */
  let deferred: Extract<BeatCue, { at: "seconds" }>[] = [];
  let wasPaused = false;
  let wasEnded = false;

  /** (커서, now] 구간을 지난, 아직 소비되지 않은 cue 들 */
  function crossedSince(from: number, now: number) {
    return secondCues.filter((c) => !consumed.has(cueKey(c)) && c.seconds > from && c.seconds <= now);
  }

  return {
    feed(pulse: VideoPulse): BeatCue[] {
      // ── 광고: currentTime 이 본편 시각이 아니다 ──────────────────────────────
      // 커서를 건드리면 본편 진행 위치를 잃는다. 아무것도 하지 않고 그대로 둔다.
      if (pulse.adShowing) {
        log.debug("cue:blocked:ad", { seconds: Math.round(pulse.seconds) });
        return [];
      }

      const now = pulse.seconds;
      const fired: BeatCue[] = [];

      // ── 첫 평가 ────────────────────────────────────────────────────────────
      // 재생 도중에 Pet 을 불렀을 수 있다. 지난 질문이 한꺼번에 쏟아지면 안 되므로
      // 이미 지나친 cue 는 전부 조용히 버리고 커서만 세운다.
      if (cursor === null) {
        for (const cue of secondCues) {
          if (cue.seconds <= now) {
            consumed.add(cueKey(cue));
            log.info("cue:passed-before-start", { at: cue.seconds, now: Math.round(now) });
          }
        }
        cursor = now;
        wasPaused = pulse.paused;
        wasEnded = pulse.ended;
        return [];
      }

      const step = now - cursor;
      const crossed = step > 0 ? crossedSince(cursor, now) : [];
      for (const cue of crossed) consumed.add(cueKey(cue));

      if (step < 0 || step > MAX_NORMAL_STEP_SEC) {
        // ── seek ─────────────────────────────────────────────────────────────
        // 사용자가 의도적으로 구간을 건너뛰었다. 건너뛴 지점의 이야기는 하지 않는다.
        for (const cue of crossed) {
          log.info("cue:passed-by-seek", { at: cue.seconds, now: Math.round(now) });
        }
        deferred = [];
      } else if (pulse.fullscreen) {
        // ── 전체화면: 시각은 유효하지만 사용자가 패널을 볼 수 없다 ──────────────
        // 커서는 정상적으로 전진시키되 발화는 미뤄 둔다 (해제 시 재평가).
        deferred.push(...crossed);
        for (const cue of crossed) {
          log.debug("cue:deferred:fullscreen", { at: cue.seconds });
        }
      } else {
        fired.push(...crossed);
        for (const cue of crossed) log.info("cue:fired", { at: cue.seconds });

        // 전체화면에서 막 빠져나왔다면 미뤄 둔 것 중 하나만 되살린다.
        // 8분 전 장면을 지금 이야기하면 이상하고, 3초 전이면 아직 "방금 그 장면"이다.
        if (deferred.length > 0) {
          const revivable = deferred.filter((c) => now - c.seconds <= RESUME_WINDOW_SEC).pop();
          if (revivable) {
            fired.push(revivable);
            log.info("cue:revived", { at: revivable.seconds, now: Math.round(now) });
          }
          for (const cue of deferred) {
            if (cue !== revivable) log.info("cue:dropped:stale", { at: cue.seconds });
          }
          deferred = [];
        }
      }

      cursor = now;

      // 사용자가 스스로 멈춘 순간 — 끼어들기 가장 좋은 자리 중 하나.
      // 전체화면 중에는 패널이 안 보이므로 발화하지 않는다.
      if (hasPausedByUser && pulse.paused && !wasPaused && !pulse.ended && !pulse.fullscreen) {
        const key = cueKey({ at: "paused-by-user" });
        if (!consumed.has(key)) {
          consumed.add(key);
          fired.push({ at: "paused-by-user" });
          log.info("cue:fired", { at: "paused-by-user" });
        }
      }

      // 종료는 상승 에지에서만
      if (hasEnded && pulse.ended && !wasEnded) {
        const key = cueKey({ at: "ended" });
        if (!consumed.has(key)) {
          consumed.add(key);
          fired.push({ at: "ended" });
          log.info("cue:fired", { at: "ended" });
        }
      }

      wasPaused = pulse.paused;
      wasEnded = pulse.ended;
      return fired;
    },

    consumedKeys(): string[] {
      return [...consumed];
    },

    consume(cue: BeatCue): void {
      consumed.add(cueKey(cue));
    },

    reset(): void {
      consumed.clear();
      cursor = null;
      deferred = [];
      wasPaused = false;
      wasEnded = false;
    },
  };
}
