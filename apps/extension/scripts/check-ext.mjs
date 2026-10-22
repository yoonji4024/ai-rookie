#!/usr/bin/env node
// ============================================================================
// 확장 빌드 산출물 검사.
//
// 가장 중요한 항목은 content script 가 IIFE 로 남아 있는가다.
// CRXJS 는 content script 가 다른 청크와 런타임 값을 공유하면 IIFE 를 버리고
// `await import(chrome.runtime.getURL(...))` 로더로 바꾼다. 그러면 실행이 비동기가
// 되고 내부 청크가 web_accessible_resources 로 노출된다. 사람이 매번 확인할 수 없으니
// 빌드가 검사한다 — 값 import 를 하나만 넣어도 여기서 실패해야 한다.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const DIST = resolve(ROOT, "dist-ext");
const problems = [];

if (!existsSync(DIST)) {
  console.error("[check:ext] dist-ext 가 없습니다. npm run build:ext 를 먼저 돌리세요.");
  process.exit(1);
}

// ── 1. manifest 가 가리키는 파일이 실제로 있는가 ─────────────────────────────
const manifestPath = resolve(DIST, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[check:ext] manifest.json 이 없습니다.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
if (manifest.side_panel) problems.push("side_panel 이 남아 있습니다 — 두리는 페이지 위에 떠 있어야 합니다(엔진이 둘 돌면 같은 영상에 두 번 말한다).");
for (const war of manifest.web_accessible_resources ?? []) {
  for (const r of war.resources ?? []) if (r.endsWith(".html")) referenced.push(r);
}
if (manifest.options_page) referenced.push(manifest.options_page);
if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
for (const size of Object.values(manifest.icons ?? {})) referenced.push(size);
for (const cs of manifest.content_scripts ?? []) referenced.push(...(cs.js ?? []));

for (const rel of referenced) {
  if (!existsSync(resolve(DIST, rel))) problems.push(`manifest 가 가리키는 ${rel} 가 없습니다.`);
}

// ── 2. content script 가 통짜 IIFE 인가 ─────────────────────────────────────
// 주의: "매니페스트가 가리키는 파일이 IIFE 로 시작하는가"만 보면 안 된다.
// CRXJS 는 값 import 가 있으면 IIFE 로 된 *로더*를 따로 만들고 매니페스트를 그쪽으로
// 돌린다. 그 로더는 진짜 코드를 await import(chrome.runtime.getURL(...)) 로 불러오고,
// 내부 청크가 web_accessible_resources 에 노출된다. 그래서 로더 패턴 자체를 잡아야 한다.
const contentFiles = (manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
if (contentFiles.length === 0) problems.push("content script 가 하나도 없습니다.");

for (const rel of contentFiles) {
  const path = resolve(DIST, rel);
  if (!existsSync(path)) continue;
  const src = readFileSync(path, "utf-8");
  const head = src.trimStart().slice(0, 24);

  const isIife =
    head.startsWith("(function(") ||
    head.startsWith("(function ") ||
    head.startsWith("(()=>{") ||
    head.startsWith("(() => {");
  if (!isIife) {
    problems.push(
      `${rel} 가 IIFE 로 시작하지 않습니다 (앞부분: ${JSON.stringify(head)}).`,
    );
  }

  // ★ 핵심 검사: 동적 로더로 바뀌었는가
  if (/import\(\s*(\/\*[^*]*\*\/\s*)?chrome\.runtime\.getURL/.test(src)) {
    problems.push(
      `${rel} 가 동적 로더입니다 — content script 에서 값 import 를 했습니다.\n` +
      `      import type 만 쓰세요. 지금 상태로는 실행이 비동기가 되고 내부 청크가 노출됩니다.`,
    );
  }

  if (/^\s*import\s+[^(]/m.test(src) || /^\s*export\s/m.test(src)) {
    problems.push(`${rel} 에 최상위 import/export 가 있습니다 — 모듈로 번들됐습니다.`);
  }

  // ★ 산출물이 파싱은 되는가.
  // 실제로 겪은 일: CRXJS 가 IIFE 를 닫는 괄호를 소스맵 주석 뒤에 붙여
  //   //# sourceMappingURL=....js.map})()
  // 가 되면서 줄 주석이 닫는 괄호를 삼켰다. content script 가 통째로 실행되지 않는데도
  // 확장은 정상 로드되고 서비스 워커도 살아 있어 겉으로는 멀쩡해 보였다.
  try {
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
  } catch (err) {
    const detail = String(err.stderr ?? err).split("\n").find((l) => l.includes("Error")) ?? "파싱 실패";
    problems.push(`${rel} 가 유효한 JavaScript 가 아닙니다 — ${detail.trim()}`);
  }
}

// content script 때문에 *추가* 내부 청크가 페이지에 노출되면 안 된다.
// CRXJS 는 content script 파일 자신은 늘 여기에 넣는다 — 그건 정상이다.
// 그 외의 assets/*.js 가 끼어 있으면 값 import 로 코드가 쪼개졌다는 뜻이다.
const contentOwn = new Set(contentFiles.flatMap((f) => [f, `${f}.map`]));
const war = manifest.web_accessible_resources ?? [];
const leakedChunks = war
  .flatMap((entry) => entry.resources ?? [])
  .filter((r) => /^assets\/.*\.js$/.test(r) && !contentOwn.has(r));
if (leakedChunks.length > 0) {
  problems.push(
    `web_accessible_resources 에 내부 청크 ${leakedChunks.length}개가 노출됐습니다: ` +
    `${leakedChunks.slice(0, 3).join(", ")}\n` +
    `      content script 의 값 import 때문입니다.`,
  );
}

// ── 2-1. content script 가 어디에 붙는가 ─────────────────────────────────────
// 진짜 유튜브와 MemTube(시연 사이트) 둘 다여야 한다. 하나가 빠지면 확장은 멀쩡히 로드되고
// 그 사이트에서만 조용히 아무 일도 일어나지 않는다.
const REQUIRED_MATCHES = ["https://www.youtube.com/*", "http://memtube.localhost/*"];
const matches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
for (const m of REQUIRED_MATCHES) {
  if (!matches.includes(m)) problems.push(`content script matches 에 ${m} 가 없습니다.`);
}

// ── 2-2. content script 의 프로토콜 버전이 공용 정의와 같은가 ────────────────
// content script 는 값 import 를 못 해서 버전 상수를 복제해 둔다. 복제는 어긋난다 —
// 어긋나면 두리는 모든 메시지를 "버전 불일치"로 버리고 영상을 영영 모른다.
const protocolSrc = readFileSync(resolve(ROOT, "src/shared/protocol.ts"), "utf-8");
const sharedVersion = protocolSrc.match(/export const PROTOCOL_VERSION = (\d+);/)?.[1];
for (const rel of contentFiles) {
  const path = resolve(DIST, rel);
  if (!existsSync(path)) continue;
  const contentVersion = readFileSync(path, "utf-8").match(/(?:const|let|var) V = (\d+);/)?.[1];
  if (!sharedVersion || contentVersion !== sharedVersion) {
    problems.push(
      `${rel} 의 프로토콜 버전(${contentVersion ?? "?"})이 src/shared/protocol.ts(${sharedVersion ?? "?"})와 다릅니다.`,
    );
  }
}

// ── 2-3. 떠 있는 두리(iframe) 문서가 제대로 나갔는가 ─────────────────────────
// web_accessible_resources 로만 가리키는 HTML 은 CRXJS 가 번들하지 않고 복사만 한다.
// 그러면 .tsx 를 가리키는 채로 나가 빈 iframe 이 뜬다 — 실제로 겪었다.
const PET_PAGE = "extension/pet.html";
const petWar = (manifest.web_accessible_resources ?? []).find((w) => (w.resources ?? []).includes(PET_PAGE));
if (!petWar) {
  problems.push(`${PET_PAGE} 가 web_accessible_resources 에 없습니다 — 페이지가 두리 iframe 을 띄울 수 없습니다.`);
} else {
  for (const m of REQUIRED_MATCHES) {
    if (!(petWar.matches ?? []).includes(m)) problems.push(`${PET_PAGE} 가 ${m} 에 열려 있지 않습니다.`);
  }
}
const petHtmlPath = resolve(DIST, PET_PAGE);
if (existsSync(petHtmlPath)) {
  const html = readFileSync(petHtmlPath, "utf-8");
  if (/src="[^"]*\.tsx?"/.test(html)) problems.push(`${PET_PAGE} 가 번들되지 않았습니다 — 아직 .tsx 를 가리킵니다.`);
  for (const src of html.match(/src="([^"]+\.js)"/g) ?? []) {
    const rel = src.slice(5, -1).replace(/^\//, "");
    if (!existsSync(resolve(DIST, rel))) problems.push(`${PET_PAGE} 가 가리키는 ${rel} 가 없습니다.`);
  }
}

// ── 3. 구워 둔 음성 인덱스가 대사와 맞는가 (경고) ────────────────────────────
const voiceIndex = resolve(DIST, "voice/index.json");
if (existsSync(voiceIndex)) {
  const { keys = [] } = JSON.parse(readFileSync(voiceIndex, "utf-8"));
  const missing = keys.filter((k) => !existsSync(resolve(DIST, `voice/${k}.wav`)));
  if (missing.length > 0) problems.push(`voice/index.json 에 파일 없는 키 ${missing.length}개가 있습니다.`);
  if (keys.length === 0) {
    console.warn("[check:ext] 경고: 구워 둔 음성이 없습니다. npm run bake:voice 를 돌리면 무대에서 네트워크 없이도 소리가 납니다.");
  }
} else {
  console.warn("[check:ext] 경고: voice/index.json 이 없습니다.");
}

// ── 4. 산출물 크기 요약 ──────────────────────────────────────────────────────
function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

if (problems.length > 0) {
  console.error(`\n[check:ext] 문제 ${problems.length}건:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`[check:ext] 통과 — dist-ext ${(dirSize(DIST) / 1024).toFixed(0)}KB, content script ${contentFiles.length}개`);
