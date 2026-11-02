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
