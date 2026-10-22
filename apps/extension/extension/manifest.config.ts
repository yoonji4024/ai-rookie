import { defineManifest } from "@crxjs/vite-plugin";
import connection from './connection.json';

// ============================================================================
// MV3 매니페스트.
//
// 설계 판단이 몇 개 박혀 있다.
//
// · storage는 로그인 세션용이다. 마이크는 사용자가 말하기를 누른 뒤 브라우저에 요청한다.
//
// · 두리는 사이드 패널이 아니라 영상 페이지 위에 떠 있다. content script(petOverlay)가
//   extension/pet.html 을 iframe 으로 띄우므로, 그 문서를 두 사이트에 web_accessible 로 연다.
//   다른 사이트는 이 문서를 품을 수 없다.
//
// · matches 를 /watch* 로 좁히지 않는다. 유튜브는 SPA 라서 홈에서 영상으로 들어가면
//   content script 가 다시 주입되지 않는다 — 좁게 잡으면 "홈을 거쳐 들어가면 Pet 이
//   안 붙는" 간헐 버그가 된다.
//
// · content_security_policy 를 적지 않는다. MV3 기본 CSP 에는 media-src 도
//   default-src 도 없어서 data:audio/wav 재생이 검사조차 되지 않는다. 흔한 복붙인
//   "default-src 'self'" 를 적는 순간 media-src 가 그쪽으로 폴백되어 오디오가 죽는다.
//
// · key 를 고정해야 한다. 개발자 모드로 압축 해제 로드하면 확장 ID 가 경로에 따라
//   달라져서, 팀원마다 ID 가 다르면 릴레이 CORS 화이트리스트가 어긋난다.
//   connection.json의 개발용 공개키와 서버의 정확한 origin 허용 목록을 함께 고정한다.
// ============================================================================

export default defineManifest({
  manifest_version: 3,
  name: "MEMFLIX 함께 보기",
  key: connection.key,
  version: "0.3.8",
  description: "보시던 영상 옆에서 같이 보고 말을 거는 반려 캐릭터입니다.",
  minimum_chrome_version: "116",

  icons: {
    16: "icons/duri-seahorse.png",
    32: "icons/duri-seahorse.png",
    48: "icons/duri-seahorse.png",
    128: "icons/duri-seahorse.png",
  },

  action: {
    default_title: "MEMFLIX · 두리와 함께 보기",
    default_popup: "extension/popup.html",
    default_icon: { 16: "icons/duri-seahorse.png", 32: "icons/duri-seahorse.png" },
  },

  permissions: ["storage"],

  host_permissions: [
    "https://www.youtube.com/*",
    // 기존 웹 미리보기의 API 프록시 → SSH 터널 → GPU 서버.
    "http://127.0.0.1/*",
  ],

  background: {
    service_worker: "extension/src/background/serviceWorker.ts",
    type: "module",
  },

  options_page: "extension/options.html",

  content_scripts: [
    {
      // memtube.localhost 는 유튜브 DOM 을 흉내 낸 시연·검증 사이트다(npm run tv).
      // 크롬은 *.localhost 를 항상 이 컴퓨터로 풀기 때문에 외부로 새지 않고,
      // 호스트를 이렇게 좁혀 두면 같은 컴퓨터의 웹앱(localhost:5173)에는 주입되지 않는다.
      // 포트를 적지 않으면 모든 포트에 맞는다.
      matches: ["https://www.youtube.com/*", "http://memtube.localhost/*"],
      // 순서가 중요하다: petOverlay 가 isolated world 에 다리(memflixPetOverlay)를 먼저 놓는다
      js: ["extension/src/content/petOverlay.ts", "extension/src/content/youtubeAgent.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],

  web_accessible_resources: [
    {
      resources: ["extension/pet.html"],
      matches: ["https://www.youtube.com/*", "http://memtube.localhost/*"],
    },
  ],
});
