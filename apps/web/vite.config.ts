import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// VARCO Voice TTS도 채점 백엔드의 /api/tts를 거친다. 브라우저·Vite 환경에
// 국내 API 키를 두지 않고 한 서버에서 채점과 질문 음성을 함께 제공한다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        // Voice-to-Face(SyncFace) — 같은 NC OpenAPI 키를 쓰는 블렌드셰이프 생성 API
        "/api/varco-face": {
          target: "https://openapi.ai.nc.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/varco-face/, "/fa/asfa/v1.1/blendshape"),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("openapi_key", env.VARCO_TTS_KEY ?? "");
            });
          },
        },
        // 채점 백엔드(ai-rookie) — 음향·언어 피처 추출, 5축 채점, 근거 기반 해석.
        // 국내 LLM API 키는 전부 이 백엔드가 갖는다. 프론트 번들에 키가 들어가지 않는다.
        // 로컬 실행: cd ../ai-rookie && GPU .venv/bin/python -m uvicorn src.api.portal_server:app --host 127.0.0.1 --port 8001
        "/api/score": {
          target: env.SCORE_API_URL || "http://127.0.0.1:8001",
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/api\/score/, "/api"),
        },
      },
    },
  };
});
