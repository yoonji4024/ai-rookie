import { test } from "node:test";
import assert from "node:assert/strict";

import { createTurnRunner } from "../pet/turnRunner.ts";
import type { PetPhase, PetBubble } from "../pet/turnRunner.ts";
import type { BeatOutcome, PetBeat } from "../pet/types.ts";
import type { SpeakFn, SpeechResult, SpeechEndReason } from "../voice/speak.ts";
import { setObsConsoleMirror } from "../obs/log.ts";

setObsConsoleMirror(false);

/** 즉시 끝나는 가짜 음성. reason 을 바꿔 실패 상황을 주입한다 */
function fakeSpeak(reason: SpeechEndReason = "ended", spoken?: string[]): SpeakFn {
  return (req) => {
    spoken?.push(req.text);
    const result: SpeechResult = { tier: "silent", reason, durationMs: 1 };
    let settle: ((r: SpeechResult) => void) | null = null;
    const done = new Promise<SpeechResult>((r) => (settle = r));
    // 다음 마이크로태스크에 끝낸다 — 동기 resolve 는 실제 오디오와 너무 다르다
    queueMicrotask(() => {
      req.onReveal(req.text.length);
      settle?.(result);
    });
    return { done, stop: () => settle?.({ ...result, reason: "stopped" }) };
  };
}

/** 영원히 끝나지 않는 음성 — 자동재생 차단으로 멈췄던 옛 결함의 모형 */
function hangingSpeak(): SpeakFn {
  return (req) => ({
    done: new Promise<SpeechResult>(() => {}), // 절대 settle 되지 않는다
    stop: () => req.onReveal(req.text.length),
  });
}

const BEAT: PetBeat = {
  id: "b1",
  cue: { at: "seconds", seconds: 15 },
  pauseVideo: false,
  turns: [
    { id: "t1", kind: "remark", text: "어머, 저 안은 얼마나 추울까요?", restMs: 0 },
    { id: "t2", kind: "selfDisclosure", text: "저는 추운 거 진짜 못 참아요.", restMs: 0 },
    { id: "t3", kind: "ask", text: "몇 도라고 나왔죠?", simulatedAnswer: "영하 75도요", ack: "맞아요!", restMs: 0 },
  ],
};

interface RunLog {
  outcome: BeatOutcome | null;
  doneCount: number;
  bubbles: PetBubble[];
  phases: PetPhase[];
}

function run(beat: PetBeat, speak: SpeakFn, opts: { answer?: string } = {}) {
  const rec: RunLog = { outcome: null, doneCount: 0, bubbles: [], phases: [] };
  const runner = createTurnRunner({
    beat,
    speak,
    petVoiceId: "pet",
    simulatedUserVoiceId: "user",
    answer: async (turn) => opts.answer ?? turn.simulatedAnswer ?? "",
    onBubble: (b) => rec.bubbles.push({ ...b }),
    onBubbleText: (id, text) => {
      const b = rec.bubbles.find((x) => x.id === id);
      if (b) b.text = text;
    },
    onPhase: (p) => rec.phases.push(p),
    onDone: (o) => {
      rec.doneCount += 1;
      rec.outcome = o;
    },
    budgetMs: () => 50, // 테스트는 빠르게
  });
  return { runner, rec };
}

/** onDone 이 불릴 때까지 기다린다 (테스트용, 상한 있음) */
async function waitDone(rec: RunLog, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (rec.doneCount === 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("모든 턴을 순서대로 말하고 completed 로 끝난다", async () => {
  const spoken: string[] = [];
  const { runner, rec } = run(BEAT, fakeSpeak("ended", spoken));
  runner.run();
  await waitDone(rec);

  assert.equal(rec.doneCount, 1);
  assert.equal(rec.outcome?.status, "completed");
  // Pet 이 말한 문장 + 사용자 대역 낭독 + ack
  assert.deepEqual(spoken, [
    "어머, 저 안은 얼마나 추울까요?",
    "저는 추운 거 진짜 못 참아요.",
    "몇 도라고 나왔죠?",
    "영하 75도요", // 사용자 대역
    "맞아요!",     // ack
  ]);
  const answers = rec.outcome?.status === "completed" ? rec.outcome.answers : {};
  assert.deepEqual(answers, { t3: "영하 75도요" });
});

test("사용자 말풍선이 답변 뒤에 한 번 들어간다", async () => {
  const { runner, rec } = run(BEAT, fakeSpeak());
  runner.run();
  await waitDone(rec);
  const userBubbles = rec.bubbles.filter((b) => b.speaker === "user");
  assert.equal(userBubbles.length, 1);
  assert.equal(userBubbles[0].text, "영하 75도요");
});

// ── 회귀 테스트 ──────────────────────────────────────────────────────────────
// 예전 구현은 audio.play() 거부를 삼켰고, 턴을 끝내는 경로가 onended 뿐이라
// 자동재생이 막히면 대화가 영구 정지했다 — 예외도 로그도 없이.
test("자동재생이 막혀도 끝까지 진행하고 degraded 로 끝난다 (무한대기 회귀)", async () => {
  const spoken: string[] = [];
  const { runner, rec } = run(BEAT, fakeSpeak("blocked", spoken));
  runner.run();
  await waitDone(rec);

  assert.equal(rec.doneCount, 1);
  assert.equal(rec.outcome?.status, "degraded");
  assert.equal(rec.outcome?.status === "degraded" ? rec.outcome.reason : null, "voice-blocked");
  assert.equal(spoken.length, 5, "차단돼도 모든 문장을 거쳐야 한다");
});

// speak() 의 done 이 계약을 어겨도 대화가 멈추면 안 된다
test("음성이 영원히 끝나지 않아도 예산 시한이 대화를 이어준다", async () => {
  const { runner, rec } = run(BEAT, hangingSpeak());
  runner.run();
  await waitDone(rec);

  assert.equal(rec.doneCount, 1);
  assert.equal(rec.outcome?.status, "degraded");
  assert.equal(rec.outcome?.status === "degraded" ? rec.outcome.reason : null, "deadline");
});

test("말풍선의 글자는 어떤 종료 사유에서도 끝까지 채워진다", async () => {
  const { runner, rec } = run(BEAT, hangingSpeak());
  runner.run();
  await waitDone(rec);
  const petBubbles = rec.bubbles.filter((b) => b.speaker === "pet");
  for (const b of petBubbles) {
    assert.ok(b.text.length > 0, `빈 말풍선이 남았다: ${b.id}`);
  }
});

test("abort 하면 onDone 이 정확히 한 번, aborted 로 불린다", async () => {
  const { runner, rec } = run(BEAT, fakeSpeak());
  runner.run();
  runner.abort("navigated");
  await waitDone(rec);

  assert.equal(rec.doneCount, 1);
  assert.equal(rec.outcome?.status, "aborted");
  assert.equal(rec.outcome?.status === "aborted" ? rec.outcome.reason : null, "navigated");
});

test("run 전에 abort 해도 onDone 이 한 번 불린다", async () => {
  const { runner, rec } = run(BEAT, fakeSpeak());
  runner.abort("panel-closed");
  await waitDone(rec);
  assert.equal(rec.doneCount, 1);
  assert.equal(rec.outcome?.status, "aborted");
});

test("abort 를 여러 번 불러도 onDone 은 한 번뿐이다", async () => {
  const { runner, rec } = run(BEAT, fakeSpeak());
  runner.run();
  runner.abort("navigated");
  runner.abort("replaced");
  runner.abort("panel-closed");
  await waitDone(rec);
  assert.equal(rec.doneCount, 1);
});

// StrictMode 의 이펙트 2회 실행이 TTS 크레딧과 비트 청구에 얽히지 않도록
test("run 을 두 번 불러도 한 번만 진행한다 (StrictMode 멱등성)", async () => {
  const spoken: string[] = [];
  const { runner, rec } = run(BEAT, fakeSpeak("ended", spoken));
  runner.run();
  runner.run();
  await waitDone(rec);
  assert.equal(rec.doneCount, 1);
  assert.equal(spoken.length, 5, "문장이 두 배로 말해지면 안 된다");
});

test("완료 뒤 마지막 phase 는 watching 이다", async () => {
  const { runner, rec } = run(BEAT, fakeSpeak());
  runner.run();
  await waitDone(rec);
  assert.equal(rec.phases[rec.phases.length - 1], "watching");
});

test("질문이 없는 비트는 사용자 말풍선 없이 끝난다", async () => {
  const chatOnly: PetBeat = {
    id: "b2",
    cue: { at: "panel-open" },
    pauseVideo: false,
    turns: [{ id: "g1", kind: "greeting", text: "또 오셨네요! 좋다.", restMs: 0 }],
  };
  const { runner, rec } = run(chatOnly, fakeSpeak());
  runner.run();
  await waitDone(rec);
  assert.equal(rec.outcome?.status, "completed");
  assert.equal(rec.bubbles.filter((b) => b.speaker === "user").length, 0);
});
