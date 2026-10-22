// `node --test` 로 돌아간다. 의존성 0 — Node 22 의 네이티브 타입 스트리핑을 쓴다.
// 그래서 이 폴더의 import 는 반드시 확장자 ".ts" 를 붙인다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { dayKey, daysBetween, formatMonthDay, formatWeekday, now, seasonOf, setNowProvider } from "../time/now.ts";
import { getOrientationQuestions } from "../../lib/orientationQuestions.ts";
import { findForbidden } from "../pet/forbiddenWords.ts";

test("setNowProvider 가 시계를 갈아끼우고 되돌린다", () => {
  const fixed = new Date(2026, 4, 3, 9, 0);
  const restore = setNowProvider(() => fixed);
  assert.equal(now().getTime(), fixed.getTime());
  restore();
  assert.notEqual(now().getTime(), fixed.getTime());
});

test("dayKey 는 로컬 시간대 기준 YYYY-MM-DD 다", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

test("daysBetween 은 같은 날 0, 다음 날 1, 월·해를 건너도 맞다", () => {
  assert.equal(daysBetween("2026-03-10", "2026-03-10"), 0);
  assert.equal(daysBetween("2026-03-10", "2026-03-11"), 1);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1); // 2026 은 평년
  assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1);
  assert.equal(daysBetween("2026-03-11", "2026-03-10"), -1);
});

test("포맷 함수들이 주어진 시각을 따른다", () => {
  const at = new Date(2026, 6, 20, 12, 0); // 2026-07-20 은 월요일
  assert.equal(formatMonthDay(at), "7월 20일");
  assert.equal(formatWeekday(at), "월요일");
  assert.equal(seasonOf(at), "여름");
});

// ── 회귀 테스트 ──────────────────────────────────────────────────────────────
// 예전에는 orientationQuestions.ts 가 모듈 로드 시점의 날짜를 상수로 구웠다.
// 웹앱은 새로고침이 잦아 증상이 없었지만, 확장의 사이드 패널은 닫기 전까지 살아 있어서
// 자정을 넘기면 "오늘 며칠이죠?"의 기준 답이 어제가 된다.
test("지남력 문항은 호출 시점 날짜를 쓴다 (자정 결함 회귀)", () => {
  const beforeMidnight = getOrientationQuestions(new Date(2026, 0, 15, 23, 59));
  const afterMidnight = getOrientationQuestions(new Date(2026, 0, 16, 0, 1));

  const pick = (qs: ReturnType<typeof getOrientationQuestions>) =>
    qs.find((q) => q.id === "ori-time-date")!;

  assert.match(pick(beforeMidnight).correctAnswer, /1월 15일 목요일/);
  assert.match(pick(afterMidnight).correctAnswer, /1월 16일 금요일/);
  assert.notEqual(pick(beforeMidnight).correctAnswer, pick(afterMidnight).correctAnswer);
});

test("사용자에게 보이는 지남력 문구에 측정 목적이 드러나지 않는다", () => {
  for (const q of getOrientationQuestions(new Date(2026, 0, 16))) {
    for (const field of ["question", "simulatedAnswer", "feedback"] as const) {
      const hits = findForbidden(q[field]);
      assert.deepEqual(
        hits,
        [],
        `${q.id}.${field} 에 금칙어 ${hits.map((h) => h.label).join(", ")} — ${q[field]}`,
      );
    }
  }
});

// 금칙어 규칙 자체의 회귀 테스트.
// 한국어는 교착어라 단순 부분문자열 검사가 오탐을 낸다 — 그 오탐이 다시 들어오면 여기서 잡힌다.
test("금칙어 규칙이 한국어 어미를 오탐하지 않는다", () => {
  for (const ok of [
    "무슨 요일인지도 궁금해요!",
    "괜찮은지 여쭤봐도 될까요?",
    "어떤 드라마 좋아하시는지 알려주세요",
    "오늘 날씨가 어떤지 궁금해요",
  ]) {
    assert.deepEqual(findForbidden(ok), [], `정상 문장을 오탐했다: ${ok}`);
  }
});

test("금칙어 규칙이 진짜 위반은 잡는다", () => {
  for (const bad of [
    "답변 분석 중이에요",
    "이제 검사를 시작할게요",
    "인지 기능이 저하되었어요",
    "오늘 점수는 58점이에요",
    "치매 위험이 있어요",
  ]) {
    assert.ok(findForbidden(bad).length > 0, `위반 문장을 놓쳤다: ${bad}`);
  }
});

test("로그인 같은 웹앱 전용 동선을 Pet 대사가 언급하지 않는다", () => {
  for (const q of getOrientationQuestions(new Date(2026, 0, 16))) {
    assert.ok(!q.feedback.includes("로그인"), `${q.id}.feedback 이 로그인을 언급한다`);
  }
});
