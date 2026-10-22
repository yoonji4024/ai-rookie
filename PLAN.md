# MEMFLIX team handoff status — 2026-10-22

Current source, run commands and limitations: [README](README.md) and [team guide](docs/TEAM_HANDOFF.md).

- Website: apps/web, extension: apps/extension (0.3.8), API: src.api.portal_server.
- This snapshot packages the existing implementation; it does not resolve pending UX or scoring integration issues.
- Actual Chrome/microphone acceptance remains separate from mocked regression checks.
- Never commit credentials, corpora, per-person labels, user transcripts/recordings or reference distributions.
- Research and old design documents remain historical context, not evidence that every planned runtime feature is complete.
