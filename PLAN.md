# MEMFLIX team handoff status — 2026-10-22

Current source, run commands and limitations: [README](README.md) and [team guide](docs/TEAM_HANDOFF.md).

- Website: apps/web, extension: apps/extension (0.3.8), API: src.api.portal_server.
- This snapshot packages the existing implementation; it does not resolve pending UX or scoring integration issues.
- Actual Chrome/microphone acceptance remains separate from mocked regression checks.
- Never commit credentials, corpora, per-person labels, user transcripts/recordings or reference distributions.
- Research and old design documents remain historical context, not evidence that every planned runtime feature is complete.


## 2026-11-02~03 데모 인사 TTS·영상 질문 시점 수정

- origin/master fetch 후 팀원용 별도 작업 트리에서 `git pull --ff-only origin master`: 4b5349d, already up to date. 주 작업 트리의 연구 수정/미추적 파일은 보존. 수정 브랜치 `codex/demo-voice-timeline-20261102`.
- 팀원 master의 인사 화면은 수동 낭독만 있었음. 진입 안내와 각 질문을 자동 낭독하며 질문 이동·나가기·녹음 시작 시 이전 음성 취소. 실패 안내와 다시 듣기 유지. 안내 음성만으로 마이크를 열지 않음. 로컬 정본은 기존 자동 마이크/실시간 전사를 보존하고 안내 음성만 추가.
- `lnvaFy7cRmk`의 원본 문항들은 timestamp=null/after_segment: 1세션은 원영상 60~420초. 개별 장면 시간을 추정해서 만들지 않음. 구간 종료 대화임을 화면에 표시.
- 공통 시청 시계가 실제 영상 시각을 기준으로 질문을 정렬하고, 앞으로 건너뛴 경우 해당 질문 위치로 이동 후 정지 확인까지 낭독 대기. iframe end 파라미터 의존 제거, 질문 중 시각 고정, 원본 길이 부족/이동 지연 차단. 로컬 파일의 sourceStartSeconds와 기존 /demo 기능 유지.
- Node22 음성10+타임라인7검사 통과. 팀원/로컬 정본 타입 검사 및 제품 빌드 성공. 실제 React StrictMode 화면에서 안내·첫 질문·다음 질문 자동 낭독 요청, 가상 플레이어의 지연 seek·이어 보기·짧은 원본/이동 실패 처리 확인.
- Chrome 실제 YouTube 영상 lnvaFy7cRmk에서 끝 3615.121초→90초 복귀, 420초로 건너뛰기→180초 복귀, 420.003968초에서 구간 종료 질문 확인. 이 검사에서 질문·TTS·저장은 가상 입력이며 실제 마이크/STT/API 합성 성능 검증과 구분. 별도 실제 TTS 익명 요청은401(인증 필요)로 합성 미실행.
- localhost IPv6 Vite 정본과 127.0.0.1 IPv4 정적 시연에 적용. 원본/진입 HTML 백업, 기존 빌드 자산 보존, HTTP 결과 대조 완료. 백엔드/계정/실제 시청 DB 변경·재시작 없음. 검증 자료 `data/demo-timing-review-20261102/`. GitHub master 변경/푸시는 하지 않음.
- 2026-11-03 팀 공유 준비: 로컬에서 확인한 `/demo` 영상 선택·질문 8초 전 이동을 App/라이브러리/시청 화면에 연결. 일반 `/`의 시청 전 인사와 자동 질문 음성, 공통 자동 마이크·5/8초 무음 종료·전사 확인·다음 질문 흐름을 함께 반영.
- 웹 실시간 STT는 허용된 웹 Origin + 일반 사용자 로그인 쿠키로 인증하며, 확장 토큰과 구분. 기존 만료/로그아웃/동시 스트림/PCM 한도 검사 유지. 이전 master의 TTS HTTP·자동재생 오류 처리도 보존.
- 공유본 검증: Node22 프론트 34개, Python3.12 백엔드 80개, 타입 검사·제품 빌드 통과. 실제 React 컴포넌트의 가상 음성·영상 검사 12개 통과. 실제 Chrome `/demo`에서는 6:52 이동 뒤 7:00 정지·첫 질문 표시를 별도 확인. 팀원 물리 마이크·제공사 음성 응답은 pull 후 현장 확인 대상.
- README 및 TEAM_HANDOFF에 master 갱신, 웹·백엔드 재시작, `/`와 `/demo` 차이, 테스트 결과 회신 항목을 기록. API 키·DB·녹음·연구 작업 파일은 공유 범위에 넣지 않음.

## 2026-11-03 섬마을 1세션 질문 분산

- 원영상 `lnvaFy7cRmk`의 화면·화면 속 자막을 직접 표본 확인. 손님 등장/하선 뒤 q1=100초, 섬 마을 전경/마을 초입/어민회관 도착 뒤 q2=150초로 변경. q3 냉장고는 정확한 대사 시점 미확인으로 기존 after_segment=420초 유지. 다른 구간과 문항 원문·정답·채점 상태는 보존. 음성 무음 경계를 정밀 검증한 결과는 아님.
- 신규 시청 세션은 1:40 → 2:30 → 7:00에 한 문항씩 표시하며 `/demo` 이동은 각각 1:32 → 2:22 → 6:52. 기존에 열린 시청 계획에는 소급 적용하지 않으므로 목록에서 다시 영상을 선택해야 함.
- 실제 카탈로그를 읽는 회귀 검사로 질문 직후 다음 질문이 대기열에 붙지 않는지 확인. 프론트 35개, portal 48개, 카탈로그 무결성 18개 통과.
- 기존 비공개 서버의 목록과 DB를 서버 내부에 백업한 뒤 동일 runner를 재시작, health 정상. 로컬 정본/팀 공유본에도 두 타임스탬프와 검토 근거만 반영.
