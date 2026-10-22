import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isContentToPanel,
  frameMessage,
  isFrameToHost,
  isHostToFrame,
  isWorkerToContent,
  isPanelToContent,
  isVersionMismatch,
  PROTOCOL_VERSION,
  type ContentToPanel,
} from "../protocol.ts";
import { createMockHost } from "../host/mockHost.ts";
import { setObsConsoleMirror } from "../obs/log.ts";

setObsConsoleMirror(false);

const CONTENT = { provider: "youtube" as const, id: "7mYPIds26Js", title: "영하 75도 냉동창고 취재" };

test("attachId 가 있는 attached 만 받는다", () => {
  const ok = { v: PROTOCOL_VERSION, type: "video/attached", content: CONTENT, durationSec: 62, attachId: "a-1" };
  assert.equal(isContentToPanel(ok), true);
  assert.equal(isContentToPanel({ ...ok, attachId: "" }), false, "빈 attachId 로는 재공지와 새 세션을 구분할 수 없다");
  const { attachId: _drop, ...noId } = ok;
  assert.equal(isContentToPanel(noId), false, "옛 모양(attachId 없음)은 받지 않는다");
});

test("옛 버전 메시지는 버전 불일치로 드러난다", () => {
  const old = { v: 1, type: "video/pulse", pulse: {} };
  assert.equal(isContentToPanel(old), false);
  assert.equal(isVersionMismatch(old), true, "일부만 리로드된 확장은 조용히 무시하지 않고 시끄럽게 알린다");
});

test("pet/hello 는 패널 → content 메시지다", () => {
  assert.equal(isPanelToContent({ v: PROTOCOL_VERSION, type: "pet/hello" }), true);
  assert.equal(isContentToPanel({ v: PROTOCOL_VERSION, type: "pet/hello" }), false);
});

test("아이콘 토글은 content 만 받고, 패널은 영상 신호로 오해하지 않는다", () => {
  const msg = { v: PROTOCOL_VERSION, type: "pet/toggle" };
  assert.equal(isWorkerToContent(msg), true);
  assert.equal(isContentToPanel(msg), false);
  assert.equal(isPanelToContent(msg), false);
});

test("떠 있는 두리의 화면 신호는 방향과 출처 표식으로 가른다", () => {
  const size = frameMessage({ type: "frame/size", width: 120, height: 120 });
  assert.equal(isFrameToHost(size), true);
  assert.equal(isHostToFrame(size), false, "iframe 이 보낸 것을 페이지가 보낸 것으로 오해하지 않는다");
  const tap = frameMessage({ type: "host/tap" });
  assert.equal(isHostToFrame(tap), true);
  // 페이지 스크립트가 흔히 쓰는 모양의 메시지는 걸러진다
  assert.equal(isFrameToHost({ type: "frame/size", width: 1, height: 1 }), false, "버전·출처 표식이 없으면 버린다");
  assert.equal(isFrameToHost({ ...size, source: "someone-else" }), false);
});

test("목업 호스트도 확장과 같은 계약을 지킨다 — hello 에는 같은 attachId 로 다시 알린다", () => {
  const host = createMockHost();
  const seen: Extract<ContentToPanel, { type: "video/attached" }>[] = [];
  host.subscribe((msg) => {
    if (msg.type === "video/attached") seen.push(msg);
  });

  host.timeline.attach(CONTENT, 62);
  assert.equal(seen.length, 1);
  const first = seen[0].attachId;
  assert.ok(first);

  host.sendToContent({ v: PROTOCOL_VERSION, type: "pet/hello" });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].attachId, first, "재공지는 세션을 새로 열지 않도록 같은 id 여야 한다");

  // 늦게 구독한 패널도 같은 id 를 받는다
  const late: string[] = [];
  host.subscribe((msg) => {
    if (msg.type === "video/attached") late.push(msg.attachId);
  });
  assert.deepEqual(late, [first]);

  host.timeline.attach({ ...CONTENT, id: "other" }, 30);
  assert.notEqual(seen[seen.length - 1].attachId, first, "다른 영상은 새 id 로 새 세션을 연다");
});
