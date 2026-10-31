import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {playVarcoTts, synthesizeVarcoTts} from '../src/lib/varcoTts.ts';
import {fetchTranscript} from '../src/lib/scoreApi.ts';

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const flush = () => new Promise(resolve => setImmediate(resolve));
let cancel: (() => void) | undefined;
afterEach(() => {
  cancel?.(); cancel = undefined;
  globalThis.fetch = originalFetch;
  globalThis.Audio = originalAudio;
});
function response(body: unknown, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), {status});
}
function audio(playError?: Error) {
  let instance: FakeAudio;
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {instance = this;}
    async play() {if (playError) throw playError;}
    pause() {}
  }
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  return () => instance;
}

test('missing TTS service returns an actionable HTTP failure', async () => {
  response({detail: 'provider not configured'}, 503);
  await assert.rejects(synthesizeVarcoTts('작성한 질문', 'fixture'), /HTTP 503/);
});
test('empty successful TTS response is not treated as playable audio', async () => {
  response({audio: ''});
  await assert.rejects(synthesizeVarcoTts('작성한 질문', 'fixture'), /재생할 음성/);
});
test('synthesis failure goes to error callback, not successful completion', async () => {
  response({}, 502);
  let ended = 0, failed = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++, {}, undefined, () => failed++);
  await flush();
  assert.equal(ended, 0); assert.equal(failed, 1);
});
test('autoplay rejection is explained and completion is not signalled', async () => {
  response({audio: 'authored-fixture'});
  audio(new DOMException('denied', 'NotAllowedError'));
  let message = '', ended = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++, {}, undefined, e => message = e.message);
  await flush();
  assert.match(message, /소리 재생이 차단/); assert.equal(ended, 0);
});
test('audio decode error is reported once even if ended follows', async () => {
  response({audio: 'authored-fixture'});
  const instance = audio();
  let ended = 0, failed = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++, {}, undefined, () => failed++);
  await flush(); instance().onerror?.(); instance().onended?.();
  assert.equal(failed, 1); assert.equal(ended, 0);
});
test('successful playback ends once and cancellation ignores stale events', async () => {
  response({audio: 'authored-fixture'});
  const instance = audio();
  let ended = 0, started = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++, {}, () => started++);
  await flush();
  assert.equal(started, 1);
  instance().onended?.(); instance().onended?.();
  assert.equal(ended, 1);
  cancel(); assert.equal(instance().onended, null); assert.equal(instance().onerror, null);
});
test('legacy callers still recover after synthesis failure', async () => {
  response({}, 503);
  let ended = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++);
  await flush(); assert.equal(ended, 1);
});
test('a late synthesis result cannot play after connection timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let deliver!: (response: Response) => void;
  globalThis.fetch = () => new Promise(resolve => {deliver = resolve;});
  const instance = audio();
  let failed = 0, ended = 0;
  cancel = playVarcoTts('작성한 질문', 'fixture', () => ended++, {}, undefined, () => failed++);
  t.mock.timers.tick(65001);
  deliver(new Response(JSON.stringify({audio: 'late-fixture'})));
  await flush();
  assert.equal(failed, 1); assert.equal(ended, 0); assert.equal(instance(), undefined);
});
test('ASR returns only the actual server transcript', async () => {
  response({text: '  작성한 가상 답변입니다.  '});
  assert.equal(await fetchTranscript(new File(['fixture'], 'answer.wav')), '작성한 가상 답변입니다.');
});
test('ASR failure keeps the HTTP status and never fabricates an answer', async () => {
  response({}, 502);
  await assert.rejects(fetchTranscript(new File(['fixture'], 'answer.wav')), /HTTP 502/);
});
