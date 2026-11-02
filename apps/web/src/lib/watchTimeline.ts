import type { WatchPlan } from './portalApi';

export type WatchCue = { prompt: WatchPlan['prompts'][number]; time: number };

/** Use source-video seconds, including for a local excerpt with an offset.
 * Missing per-question timestamps remain end-of-segment questions; never invent them.
 */
export function nextWatchCue(plan: WatchPlan, done: Set<string>, position: number, ended: boolean): WatchCue | undefined {
  return plan.prompts.flatMap(prompt => {
    if (done.has(prompt.id)) return [];
    const time = prompt.delivery === 'at_time' ? prompt.timestamp : plan.segment.end ?? (ended ? position : null);
    if (time === null || !Number.isFinite(time) || time < plan.segment.start || position < time) return [];
    return [{ prompt, time }];
  }).sort((a, b) => a.time - b.time)[0];
}

export function requiredWatchEnd(plan: WatchPlan): number {
  return Math.max(plan.segment.start, plan.segment.end ?? 0,
    ...plan.prompts.filter(p => p.delivery === 'at_time').map(p => p.timestamp));
}

export function formatVideoTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** YouTube seekTo is asynchronous. Hold the prompt until the requested frame is paused. */
export function cueIsAligned(cue: WatchCue, position: number, playerState: number | undefined): boolean {
  return Math.abs(position - cue.time) <= .75 && (playerState === 2 || playerState === 0);
}
