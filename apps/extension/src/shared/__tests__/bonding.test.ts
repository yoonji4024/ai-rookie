import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGreetingBeat, greetingKindOf, MAX_ASK_PER_GREETING } from "../pet/greeting.ts";
import { buildClosingBeat, buildFarewellBeat } from "../pet/closing.ts";
import { captureMoment } from "../pet/moments.ts";
import { createMemory, rememberNote, touchMeeting, QUOTE_MAX_CHARS } from "../pet/memory.ts";
import type { PetBeat, ContentRef } from "../pet/types.ts";
import { dayKey } from "../time/now.ts";
import { setObsConsoleMirror } from "../obs/log.ts";
import { findForbidden } from "../pet/forbiddenWords.ts";

setObsConsoleMirror(false);

const DAY1 = new Date(2026, 2, 10, 9, 0);
const DAY2 = new Date(2026, 2, 11, 9, 0);
const DAY9 = new Date(2026, 2, 18, 9, 0);
const CONTENT: ContentRef = { provider: "youtube", id: "abc", title: "한국기행" };

// ── 유대감 ① 아침 인사 ──────────────────────────────────────────────────────

test("첫 만남에는 자기소개를 한다", () => {
  const beat = buildGreetingBeat(createMemory(dayKey(DAY1)), DAY1);
  assert.equal(greetingKindOf(createMemory(dayKey(DAY1)), dayKey(DAY1)), "first-meeting");
  assert.match(beat.turns[0].text, /두리/);
});

test("같은 날 다시 열면 인사를 처음부터 다시 하지 않는다", () => {
  const memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  const beat = buildGreetingBeat(memory, DAY1);
  assert.equal(beat.turns.length, 1, "짧게 끝나야 한다");
  assert.equal(beat.turns[0].kind, "greeting");
});

test("며칠 만에 와도 질책하지 않는다", () => {
  const memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  const beat = buildGreetingBeat(memory, DAY9);
  assert.equal(greetingKindOf(memory, dayKey(DAY9)), "after-a-while");
  const all = beat.turns.map((t) => t.text).join(" ");
  for (const scold of ["왜 안", "왜 못", "안 오셨", "오래간만에야"]) {
    assert.ok(!all.includes(scold), `질책하는 말이 있다: ${scold} — ${all}`);
  }
  assert.match(all, /보고 싶었어요/);
});

test("인사에 질문은 최대 하나뿐이다", () => {
  for (const at of [DAY1, DAY2, DAY9]) {
    const memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
    const beat = buildGreetingBeat(memory, at);
    const asks = beat.turns.filter((t) => t.kind === "ask").length;
    assert.ok(asks <= MAX_ASK_PER_GREETING, `질문이 ${asks}개다 — 문진처럼 보인다`);
  }
});

test("인사는 하루 한 번만 청구된다", () => {
  const memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  const a = buildGreetingBeat(memory, DAY2);
  const b = buildGreetingBeat(memory, DAY2);
  assert.equal(a.id, b.id, "같은 날이면 같은 비트 id 라 claimBeat 이 두 번째를 막는다");
  assert.equal(a.once, "day");
});

test("지난번 이야기를 이어 받는다", () => {
  let memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  memory = rememberNote(memory, { theme: "health", quote: "무릎이 좀 아파요", recordedOn: dayKey(DAY1) });
  const beat = buildGreetingBeat(memory, DAY2);
  assert.ok(beat.turns.some((t) => t.kind === "recall"), "recall 턴이 있어야 한다");
});

// ── 유대감 ③ 약속, 그리고 ① 로 이어지는 왕복 ────────────────────────────────

test("약속과 비트가 같은 호출에서 함께 나온다", () => {
  const memory = createMemory(dayKey(DAY1));
  const { beat, promise } = buildClosingBeat(memory, DAY1, CONTENT.title);
  assert.ok(beat.turns.some((t) => t.kind === "promise"));
  assert.equal(promise.madeOn, dayKey(DAY1));
  assert.equal(promise.text, beat.turns.find((t) => t.kind === "promise")?.text,
    "말하는 문장과 저장하는 문장이 같아야 한다");
});

test("오늘 한 약속을 내일 아침에 되짚는다 (③ → ① 왕복)", () => {
  let memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  const { promise } = buildClosingBeat(memory, DAY1, CONTENT.title);
  memory = { ...memory, openPromise: promise };

  const greeting = buildGreetingBeat(memory, DAY2);
  const recalls = greeting.turns.filter((t) => t.kind === "recall");
  assert.ok(recalls.length > 0, "약속을 되짚는 턴이 없다");
  assert.match(recalls[0].text, /어제 또 보자고/);
});

test("약속이 없으면 되짚지 않는다", () => {
  const memory = touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1));
  const greeting = buildGreetingBeat(memory, DAY2);
  assert.ok(!greeting.turns.some((t) => /또 보자고/.test(t.text)), "하지 않은 약속을 말하면 안 된다");
});

test("대체 작별에는 약속 문장이 없다", () => {
  const beat = buildFarewellBeat(createMemory(dayKey(DAY1)), DAY1);
  assert.ok(!beat.turns.some((t) => t.kind === "promise"),
    "저장에 실패했는데 약속을 말하면 지키지 못할 약속이 된다");
});

// ── 유대감 ④ 순간 카드와 신뢰 경계 ──────────────────────────────────────────

const HIGHLIGHT_BEAT: PetBeat = {
  id: "b1",
  cue: { at: "seconds", seconds: 15 },
  pauseVideo: false,
  moment: { context: "냉동창고 온도", petLine: "저는 추운 거 진짜 못 참아요." },
  turns: [
    { id: "t1", kind: "remark", text: "어머!" },
    { id: "t2", kind: "ask", text: "몇 도였죠?", highlight: true, analysis: { source: "coview" } },
  ],
};

test("완주한 비트에서 카드가 만들어진다", () => {
  const card = captureMoment(HIGHLIGHT_BEAT, { t2: "영하 75도요" }, CONTENT, DAY1);
  assert.ok(card);
  assert.equal(card.quote, "영하 75도요");
  assert.equal(card.petLine, "저는 추운 거 진짜 못 참아요.");
  assert.equal(card.contentTitle, "한국기행");
});

test("긴 답변은 잘라서 담는다 (회상 대화 전문이 넘어가지 않게)", () => {
  const long = "가".repeat(400);
  const card = captureMoment(HIGHLIGHT_BEAT, { t2: long }, CONTENT, DAY1);
  assert.ok(card);
  assert.ok(card.quote.length <= QUOTE_MAX_CHARS, `${card.quote.length}자나 담았다`);
});

test("안부 대화는 보호자 카드가 되지 않는다 (신뢰 경계)", () => {
  const checkinBeat: PetBeat = {
    ...HIGHLIGHT_BEAT,
    turns: [{ id: "t2", kind: "ask", text: "오늘 누구 만나셨어요?", highlight: true, analysis: { source: "checkin" } }],
  };
  const card = captureMoment(checkinBeat, { t2: "딸이 다녀갔어요" }, CONTENT, DAY1);
  assert.equal(card, null, "아침에 나눈 사적인 이야기가 보호자 화면에 가면 안 된다");
});

test("moment 씨앗이 없는 비트는 카드를 만들지 않는다", () => {
  const plain: PetBeat = { ...HIGHLIGHT_BEAT, moment: undefined };
  assert.equal(captureMoment(plain, { t2: "영하 75도요" }, CONTENT, DAY1), null);
});

test("답변이 없으면 카드를 만들지 않는다", () => {
  assert.equal(captureMoment(HIGHLIGHT_BEAT, {}, CONTENT, DAY1), null);
  assert.equal(captureMoment(HIGHLIGHT_BEAT, { t2: "   " }, CONTENT, DAY1), null);
});

// ── 사용자에게 보이는 모든 유대감 문구 ──────────────────────────────────────

test("유대감 대사에 측정 목적이 드러나지 않는다", () => {
  const beats = [
    buildGreetingBeat(createMemory(dayKey(DAY1)), DAY1),
    buildGreetingBeat(touchMeeting(createMemory(dayKey(DAY1)), dayKey(DAY1)), DAY9),
    buildClosingBeat(createMemory(dayKey(DAY1)), DAY1, CONTENT.title).beat,
    buildFarewellBeat(createMemory(dayKey(DAY1)), DAY1),
  ];
  for (const beat of beats) {
    for (const turn of beat.turns) {
      for (const field of [turn.text, turn.ack, turn.simulatedAnswer]) {
        if (!field) continue;
        const hits = findForbidden(field);
        assert.deepEqual(hits, [], `${beat.id}/${turn.id}: ${hits.map((h) => h.label).join(",")} — ${field}`);
      }
    }
  }
});
