import { test } from "node:test";
import assert from "node:assert/strict";

import { createCueScheduler } from "../pet/cueScheduler.ts";
import type { BeatCue } from "../pet/types.ts";
import type { VideoPulse } from "../protocol.ts";
import { setObsConsoleMirror } from "../obs/log.ts";

setObsConsoleMirror(false); // 테스트 출력에 로그가 섞이지 않게

function pulse(seconds: number, prevSeconds: number, extra: Partial<VideoPulse> = {}): VideoPulse {
  return { seconds, prevSeconds, paused: false, ended: false, adShowing: false, fullscreen: false, ...extra };
}

const AT_15: BeatCue = { at: "seconds", seconds: 15 };
const AT_32: BeatCue = { at: "seconds", seconds: 32 };

test("정상 재생으로 지점을 지나면 한 번 발화한다", () => {
  const s = createCueScheduler([AT_15]);
  assert.deepEqual(s.feed(pulse(14.8, 14.6)), [], "첫 tick 은 커서를 세울 뿐 발화하지 않는다");
  assert.deepEqual(s.feed(pulse(15.1, 14.8)), [AT_15]);
});

test("같은 지점을 다시 지나도 두 번 발화하지 않는다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(14.8, 14.6));
  s.feed(pulse(15.1, 14.8));
  assert.deepEqual(s.feed(pulse(15.3, 15.1)), []);
  assert.deepEqual(s.feed(pulse(16, 15.8)), []);
});

// ── 회귀 테스트 ──────────────────────────────────────────────────────────────
// 예전 판정은 `t >= q.timestamp` 였다. 20초로 건너뛰면 15초 질문이 즉시 터졌다.
test("앞으로 건너뛴 구간의 cue 는 발화하지 않고 소비된다 (seek 폭발 회귀)", () => {
  const s = createCueScheduler([AT_15, AT_32]);
  s.feed(pulse(5, 4.8));
  // 진행 바를 5초 → 20초로 끌었다
  assert.deepEqual(s.feed(pulse(20, 5)), [], "건너뛴 15초 cue 가 터지면 안 된다");
  // 소비됐으므로 이후 정상 재생에서도 다시 터지지 않는다
  assert.deepEqual(s.feed(pulse(20.2, 20)), []);
  // 32초는 아직 살아 있다 — 정상 재생으로 그 지점까지 간다
  for (let t = 21.5; t < 31.9; t += 1.5) s.feed(pulse(t, t - 1.5));
  assert.deepEqual(s.feed(pulse(32.1, 31.4)), [AT_32]);
});

test("뒤로 감으면 이미 소비한 cue 가 되살아나지 않는다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(14.8, 14.6));
  s.feed(pulse(15.1, 14.8)); // 정상 발화
  s.feed(pulse(5, 15.3)); // 뒤로 감기
  assert.deepEqual(s.feed(pulse(15.2, 15.0)), [], "다시 지나도 재발화 없음");
});

// 유튜브 광고는 본편과 같은 <video> 로 재생되고 currentTime 이 광고 경과초로 바뀐다.
// 프리롤 15초째에 "15초 cue" 가 광고 위에서 터지면 안 된다.
// 유튜브 광고는 본편과 같은 <video> 요소로 재생되고 currentTime 이 광고 경과초로 갈아끼워진다.
// 즉 긴 프리롤의 15초째에 "15초 cue" 가 광고 위에서 터질 수 있다.
test("광고 구간은 본편 시각이 아니므로 판정 자체를 하지 않는다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(3, 2.8)); // 본편 3초까지 보다가
  // 미드롤 광고 시작 — currentTime 이 광고의 0..20 으로 바뀐다
  for (let t = 0; t <= 20; t += 2) {
    assert.deepEqual(s.feed(pulse(t, t - 2, { adShowing: true })), [], `광고 ${t}초에서 발화하면 안 된다`);
  }
  // 광고가 끝나고 본편이 3초부터 이어진다. 커서가 3 그대로라 15초를 정상적으로 지난다.
  assert.deepEqual(s.feed(pulse(3.2, 3.0)), []);
  s.feed(pulse(14.9, 13.0)); // 조금 건너뛴 tick (커서 전진)
  assert.deepEqual(s.feed(pulse(15.1, 14.9)), [AT_15], "광고가 끝난 뒤에는 정상 발화해야 한다");
});

test("전체화면에서는 발화를 미루고, 해제 직후 되살린다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(14.8, 14.6, { fullscreen: true }));
  assert.deepEqual(s.feed(pulse(15.1, 14.8, { fullscreen: true })), [], "패널이 안 보이는 동안엔 말하지 않는다");
  assert.deepEqual(s.feed(pulse(15.3, 15.1)), [AT_15], "해제하면 방금 지난 지점을 되살린다");
});

// 전체화면으로 한참 보다가 나왔을 때 8분 전 장면을 이야기하면 이상하다.
test("전체화면으로 오래 본 뒤 해제하면 오래된 cue 는 되살리지 않는다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(14.8, 14.6, { fullscreen: true }));
  s.feed(pulse(15.1, 14.8, { fullscreen: true })); // 여기서 미뤄짐
  // 전체화면으로 계속 시청 (정상 진행 tick 들)
  for (let t = 17; t < 60; t += 1.5) {
    s.feed(pulse(t, t - 1.5, { fullscreen: true }));
  }
  assert.deepEqual(s.feed(pulse(60.5, 60)), [], "45초 전 장면은 되살리지 않는다");
});

test("사용자가 직접 멈춘 순간에 한 번만 발화한다", () => {
  const cue: BeatCue = { at: "paused-by-user" };
  const s = createCueScheduler([cue]);
  assert.deepEqual(s.feed(pulse(9.8, 9.6)), []);
  assert.deepEqual(s.feed(pulse(10, 9.8)), []);
  assert.deepEqual(s.feed(pulse(10, 10, { paused: true })), [cue]);
  assert.deepEqual(s.feed(pulse(10, 10, { paused: true })), [], "멈춘 동안 반복 발화 금지");
});

test("종료는 상승 에지에서만 발화한다", () => {
  const cue: BeatCue = { at: "ended" };
  const s = createCueScheduler([cue]);
  assert.deepEqual(s.feed(pulse(58.8, 58.6)), []);
  assert.deepEqual(s.feed(pulse(59, 58.8)), []);
  assert.deepEqual(s.feed(pulse(60, 59.9, { ended: true, paused: true })), [cue]);
  assert.deepEqual(s.feed(pulse(60, 60, { ended: true, paused: true })), []);
});

test("재생 도중에 패널을 열면 지난 cue 를 발화 없이 소비한다", () => {
  const s = createCueScheduler([AT_15, AT_32]);
  // 첫 pulse 가 이미 40초 — 사용자가 한참 보다가 Pet 을 불렀다
  assert.deepEqual(s.feed(pulse(40, 39.8)), [], "지난 질문이 한꺼번에 쏟아지면 안 된다");
  assert.equal(s.consumedKeys().length, 2);
});

test("reset 하면 새 세션처럼 처음부터 다시 판정한다", () => {
  const s = createCueScheduler([AT_15]);
  s.feed(pulse(14.8, 14.6));
  s.feed(pulse(15.1, 14.8)); // 발화 + 소비
  s.reset();
  assert.deepEqual(s.feed(pulse(14.8, 14.6)), [], "reset 직후 첫 tick 은 커서를 세운다");
  assert.deepEqual(s.feed(pulse(15.1, 14.8)), [AT_15], "소비 기록이 지워져 다시 발화한다");
});
