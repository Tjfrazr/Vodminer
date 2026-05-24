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

### 2026-05-24 (session 3) — Pivot: TikTok out, Discord-only delivery
- **Decided:** TikTok automation removed entirely. The dev app review was unsuccessful. New scope: Vodminer watches TJ's Twitch VODs (post-stream), detects exciting moments, clips them, and posts to Discord as file attachments. TJ shares to other socials manually from there.
- **Deleted:** `src/tiktok/`, `src/scheduler/queue.js`, `tests/tiktok/`, `tests/scheduler/`, `tests/__fixtures__/tiktokResponses.js`. All `TIKTOK_*` env vars dropped from `.env.example` / `src/lib/env.js`. `tiktok` + `schedule` sections removed from `config.js`.
- **Kept:** `privacy-policy.html` and `terms-of-service.html` — may be needed for future API access on other platforms or a TikTok re-application.
- **Detector now real:** `src/twitch/clipDetector.js` implemented with audio-RMS spike detection (yt-dlp -f bestaudio piped to ffmpeg s16le mono 8kHz, RMS in 2s windows, threshold mean+2σ, group spikes within 8s, ±10s preroll + 30s clip length, top 15 by score). Reasonable defaults — to be tuned from real output once first VOD is processed.
- **Discord review bot simplified:** Approve/Reject buttons + `interactionCreate` handler + EventEmitter removed. `sendPreview(clip)` now posts an embed + the mp4 attachment and returns `{ clipId, previewUrl, status: 'delivered' }`. No more clip-state lifecycle.
- **`index.js` simplified:** scheduler/queue/`clipById` map removed. Pipeline: `stream.offline` → `getLatestVod` → `detectClips` → for each highlight `downloadVodSegment` → `processVideo` → `reviewBot.sendPreview`. Done.
- **Clip aspect:** kept 9:16 vertical (1080×1920). TJ confirmed Reels/Shorts is still the primary target for manual sharing.
- **Open items:**
  - Detector thresholds (`spikeStddevs: 2.0`, etc. in `config.js`) are educated defaults — first live run will tell us if they're too tight/loose.
  - `npm install` still not run.
  - No detector unit test — spawn-pipe mocking is fragile; deferred to live validation.
  - Chat-velocity signal not implemented (Twitch v5 comments endpoint is unofficial/deprecated). Audio-only for v1.

### 2026-05-24 (session 2) — Phase 2 scaffold
- **Decided:** Approach B — scaffold + non-detector modules now, defer `clipDetector.js` and `profiles/` until Phase 1 Eklipse data exists. Lead spawned 8 sub-agents in parallel after Systems Architect set folder layout.
- **Rejected (for now):** A (hold for 4 weeks) and C (full build with placeholder thresholds). Both pre-empted by the chosen approach.
- **Stack pinned by Architect:** `undici` (HTTP), `pino` (logging), `discord.js` v14, `fluent-ffmpeg`, `express`, `dotenv`, `jest`. PM2 installed globally, not in deps.
- **Host PATH binaries required:** `ffmpeg`, `ffprobe`, `yt-dlp`, `pm2 -g`. Healthcheck (`src/lib/healthcheck.js`) asserts on startup.
- **New env var:** `DISCORD_ERROR_WEBHOOK_URL` (optional) — separate from review bot, used for crash alerts.
- **Plan ID `6590249760` flagged as invalid** — too short for a Discord snowflake. Repo uses `DISCORD_CHANNEL_ID` env var only; TJ to supply real ID.
- **Integration fixes applied by Lead** (Backend's assumed contracts diverged from specialist exports):
  - `eventSub`: `createEventSubRouter()` returns `{router, emitter}`; webhook at `POST /twitch/webhook`.
  - `vodFetcher`: named exports — `getLatestVod`, `downloadVodSegment` (via `yt-dlp --download-sections`).
  - `ffmpegPipeline`: default export is `process(highlight, sourceVideoPath, captions?)` — needs Twitch segment downloaded first.
  - `reviewBot`: singleton default export (not a factory). Emits `'approved'`/`'rejected'` with just `clipId` (string).
  - `tiktok/poster`: `post(job, clip)` — needs both; orchestrator tracks `clipById` Map to pair them at post time.
- **Open items flagged by specialists:**
  - TikTok endpoint paths/field names marked `// VERIFY:` in `poster.js`/`uploader.js` — confirm against current v2 docs once app is approved.
  - Posting-window time zone is local server time (`getHours()`); not documented in `config.js`.
  - `clips/` and `pm2.log` added to `.gitignore`.
  - No persistence layer — queue/review state in-memory; survives only while process is up.
- **In progress:** TJ submitting TikTok developer app for review (2–6 weeks). Phase 1 Eklipse data collection separately.
- **Next steps:** (1) `npm install` to validate dependency resolution and run Jest; (2) confirm TikTok API field names in `poster.js`/`uploader.js`; (3) supply real `DISCORD_CHANNEL_ID`; (4) implement EventSub subscription bootstrap (one-time POST to `/helix/eventsub/subscriptions` after public ngrok URL is up).
