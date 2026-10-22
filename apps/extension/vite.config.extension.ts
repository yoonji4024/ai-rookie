import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import manifest from "./extension/manifest.config";

// ============================================================================
// 확장 빌드.
//
// 기존 웹앱 빌드(vite.config.ts)는 손대지 않는다 — 두 타깃이 같은 src/ 를 공유하되
// 진입점만 다르다. 웹앱은 백업 경로이자 보호자 리포트의 집이므로 계속 살아 있어야 한다.
//
// minify 를 끄는 이유: 무대에서 DevTools 로 스택을 읽는 것이 번들 크기보다 가치 있다.
// 코드가 그대로 남으므로 소스맵 없이도 읽을 수 있다.
//
// sourcemap 을 끄는 이유는 더 구체적이다. CRXJS 가 content script 를 IIFE 로 감쌀 때
// 닫는 괄호를 소스맵 주석 *뒤*에 붙이는데, 그 주석이 줄 주석이라 닫는 괄호까지 삼킨다:
//     //# sourceMappingURL=....js.map})()
// 결과는 SyntaxError 로 content script 가 통째로 실행되지 않는 것이다. 확장은 정상적으로
// 로드되고 서비스 워커도 살아 있어서 겉으로는 멀쩡해 보인다 — 정확히 "조용한 고장"이다.
// scripts/check-ext.mjs 가 산출물의 문법을 직접 검사해 이 상태를 다시 놓치지 않게 한다.
// ============================================================================

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: { alias: { "@shared": resolve(process.cwd(), "src/shared") } },
  publicDir: resolve(process.cwd(), "extension/public"),
  build: {
    outDir: "dist-ext",
    emptyOutDir: true,
    target: "chrome116",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // 화면에 떠 있는 두리(iframe)의 문서. 매니페스트에서 web_accessible_resources 로만 가리키는
      // HTML 은 CRXJS 가 번들하지 않고 그대로 복사한다 — 그러면 main.tsx 를 못 읽어 빈 iframe 이 뜬다.
      // 그래서 진입점으로 직접 넣는다. scripts/check-ext.mjs 가 산출물의 스크립트 경로를 확인한다.
      input: { pet: resolve(process.cwd(), "extension/pet.html") },
    },
  },
});
