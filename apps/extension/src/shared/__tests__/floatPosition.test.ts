import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampPosition,
  DEFAULT_POSITION,
  dogCenter,
  moveBy,
  reanchor,
  reviveFloatPosition,
  toCss,
} from "../float/position.ts";

const VIEW = { width: 1200, height: 800 };

test("오른쪽 아래에 붙어 있으면 왼쪽 위로 끌수록 모서리에서 멀어진다", () => {
  const p = moveBy({ h: "right", x: 16, v: "bottom", y: 16 }, -100, -50);
  assert.deepEqual(p, { h: "right", x: 116, v: "bottom", y: 66 });
});

test("왼쪽 위에 붙어 있으면 같은 끌기가 반대로 적용된다", () => {
  const p = moveBy({ h: "left", x: 200, v: "top", y: 100 }, -100, -50);
  assert.deepEqual(p, { h: "left", x: 100, v: "top", y: 50 });
});

test("놓은 자리의 사분면으로 다시 붙되 강아지는 제자리다", () => {
  const dragged = { h: "right" as const, x: 900, v: "bottom" as const, y: 600 };
  const before = dogCenter(dragged, VIEW);
  const after = reanchor(dragged, VIEW);
  assert.equal(after.h, "left", "화면 왼쪽 절반으로 끌었으니 왼쪽에 붙는다");
  assert.equal(after.v, "top");
  assert.deepEqual(dogCenter(after, VIEW), before, "모서리를 바꿔도 강아지 위치는 같다");
});

test("창이 줄어도 강아지가 화면 밖으로 나가지 않는다", () => {
  const far = { h: "left" as const, x: 1100, v: "top" as const, y: 750 };
  const small = { width: 600, height: 400 };
  const c = dogCenter(clampPosition(far, small), small);
  assert.ok(c.x + 48 <= small.width && c.y + 48 <= small.height, JSON.stringify(c));
});

test("CSS 로 바꾸면 붙지 않은 쪽은 auto", () => {
  assert.deepEqual(toCss(DEFAULT_POSITION), { left: "auto", right: "16px", top: "auto", bottom: "16px" });
});

test("저장소 값이 깨져 있으면 기본 자리로", () => {
  assert.deepEqual(reviveFloatPosition({ h: "middle", x: 1, v: "top", y: 2 }), DEFAULT_POSITION);
  assert.deepEqual(reviveFloatPosition(null), DEFAULT_POSITION);
  assert.deepEqual(reviveFloatPosition({ h: "left", x: 10, v: "top", y: Number.NaN }), DEFAULT_POSITION);
  assert.deepEqual(reviveFloatPosition({ h: "left", x: 10, v: "top", y: 20 }), { h: "left", x: 10, v: "top", y: 20 });
});
