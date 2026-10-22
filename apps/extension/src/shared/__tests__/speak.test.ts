import { test } from "node:test";
import assert from "node:assert/strict";

import { createSilentSpeak } from "../voice/speak.ts";
import { setObsConsoleMirror } from "../obs/log.ts";

setObsConsoleMirror(false);

// createSpeak 의 baked/live 칸은 브라우저 API(Audio, Blob, fetch)에 의존해
// /pet 프리뷰의 브라우저 검증이 맡는다. 여기서는 어떤 경우에도 done 이 settle 된다는
// 계약을 사다리의 마지막 칸(silent)에서 고정한다 — 이 칸은 오디오를 쓰지 않으므로
// 자동재생 정책과 무관하게 항상 끝나야 한다.

test("무음 폴백은 글자를 다 드러내고 ended 로 끝난다", async () => {
  const shown: number[] = [];
  const speak = createSilentSpeak(1);
  const h = speak({
    text: "안녕하세요",
    voiceId: "v",
    withFace: false,
    onReveal: (n) => shown.push(n),
  });
  const r = await h.done;
  assert.equal(r.tier, "silent");
  assert.equal(r.reason, "ended");
  assert.equal(shown[shown.length - 1], 5);
});

test("stop() 하면 즉시 끝나고 글자는 전부 보인다", async () => {
  let last = 0;
  const speak = createSilentSpeak(50);
  const h = speak({
    text: "긴 문장을 말하는 중입니다",
    voiceId: "v",
    withFace: false,
    onReveal: (n) => (last = n),
  });
  h.stop();
  const r = await h.done;
  assert.equal(r.reason, "stopped");
  assert.equal(last, "긴 문장을 말하는 중입니다".length, "중단해도 문장은 끝까지 보여준다");
});

test("빈 문자열에도 done 이 settle 된다", async () => {
  const speak = createSilentSpeak(1);
  const h = speak({ text: "", voiceId: "v", withFace: false, onReveal: () => {} });
  const r = await h.done;
  assert.equal(r.reason, "ended");
});

test("stop() 을 여러 번 불러도 안전하다", async () => {
  const speak = createSilentSpeak(1);
  const h = speak({ text: "가나다", voiceId: "v", withFace: false, onReveal: () => {} });
  h.stop();
  h.stop();
  h.stop();
  const r = await h.done;
  assert.equal(r.reason, "stopped");
});
