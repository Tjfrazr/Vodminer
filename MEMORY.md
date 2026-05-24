# MEMORY.md

Significant decisions, rejected alternatives, and session summaries for Vodminer.
Read before each session. Append latest entries at the bottom (earliest → latest).

---

## Decisions

### 2026-05-24 — Project kickoff
- **Decided:** Build automated Twitch → TikTok highlight pipeline (Vodminer).
- **Stack:** Node.js 20+, ES modules, ffmpeg, Discord bot, TikTok Content Posting API.
- **Rejected:** Paid tools / subscriptions — constraint is 100% free tooling.
- **Rejected:** TypeScript — plain JS to keep the surface small.

### 2026-05-24 — Credentials handling
- **Decided:** All API keys stored in git secrets, fetched at runtime. Never hardcoded, never committed to source files (including the plan doc).
- **Why:** Earlier draft of `stream_to_tiktok_plan-2.md` contained Twitch client ID/secret inline; they were removed before push.

### 2026-05-24 — Phased approach
- **Decided:** Phase 1 = Eklipse free tier for data collection (weeks 1–4); Phase 2 = custom Node.js pipeline build; Phase 3 = tuning + analytics. See `stream_to_tiktok_plan-2.md`.

---

## Session Summaries

### 2026-05-24
- Initial repo setup. Added project plan (`stream_to_tiktok_plan-2.md`) and initial `CLAUDE.md`.
- Pushed to `origin/main`.
- Updated plan: revised overview, removed inline credentials (moved to git secrets).
- Merged universal working-style rules into `CLAUDE.md`. Created `MEMORY.md`, `ERRORS.md`, `runninglog.txt`, and `.claude/commands/deferred.txt`.
- **In progress:** Pre-Phase-2 setup. No source code written yet.
- **Next steps:** Submit TikTok developer app for `video.publish` scope (2–6 week review). Begin Phase 1 data collection via Eklipse.
