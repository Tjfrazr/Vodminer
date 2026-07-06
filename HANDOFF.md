# Handoff — YouTube Phase 2a tjloop mid-Align; VOD 2813242741 still failing (yt-dlp bug)  ·  [2026-07-06 16:12 ET]

**Branch:** main  ·  **Last commit:** 02a3339 docs: add unfinishedtasks handoff for v2 Phase 2 (YouTube)
**Resume by:** Answer Question 1 of the tjloop `grilling` Align step for Phase 2a — "should raw-VOD YouTube upload run automatically in the live pipeline, or as a standalone script first?" (recommended: standalone) — this was the literal last thing asked before this handoff.

## Mission
Extend Vodminer's working Twitch clip pipeline with a YouTube publishing pipeline (Phase 2/3), 100% free/open-source tooling only, executed as one continuous `/tjloop`-gated goal (TJ corrected an earlier framing that treated the 5-phase roadmap as independent picks — it's one goal).

## What we did this session
- Booted Vodminer live via `/vodminer`: fixed ngrok (no authtoken → added one; agent too old 3.3.1→3.39.9), installed missing Playwright Chromium, ran one-time interactive Twitch login (`state/playwright-profile/` didn't exist on this machine before today)
- Wired previously-dead-code `checkForUnprocessedVod` into `index.js` startup — "catches up on unprocessed VODs on boot" now actually works (UNCOMMITTED)
- Ran the startup catch-up on VOD `2813242741` (Forza Horizon 6, 3h3m) — `audioTransient` and `motion` both failed, 0 highlights
- Added live Discord progress pings per detector (🔎/✅/⚠️) via a new `onProgress` callback through `runDetectors` → `processVod` → `runPipeline` (UNCOMMITTED, not live yet — server not restarted)
- Found + fixed a real bug: a VOD got marked "processed" even though every detector failed (per-detector failures are caught as data, not thrown, so the skip-marking guard never fired) — this VOD would never have been retried automatically. Fixed via `detectorsRun`/`allDetectorsFailed` in `src/pipeline.js` (UNCOMMITTED). Logged in `ERRORS.md` (gitignored locally).
- Retried `2813242741` via `scripts/reprocess-vod.js` post-fix — **failed again, identical failure mode** — confirms the real bug is upstream in yt-dlp, not the mark-processed logic
- Ran a background research agent across 12 tool areas (video understanding, auto-edit, scene/highlight detection, STT, OCR, audio analysis, thumbnails, SEO, metadata, publishing) for free/OSS-only options
- Wrote `docs/v2-phase2-youtube-architecture.md` (full architecture + phased roadmap 2a→2b→3a→3b→3c), then updated it per TJ's decision that title generation (not auto-edit/render/thumbnails) extends to the Twitch clip path too (untracked, new)
- Walked TJ through Google Cloud Console live: project `vodminer` created, YouTube Data API v3 enabled, OAuth consent screen configured (External, `youtube.upload` scope, test user `d0ncorl3one23@gmail.com` — the upload/gaming account, distinct from Cloud-owner `tjfrazr@gmail.com`), Desktop OAuth client created
- Added `YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET` to `.env` (gitignored) and documented all three YouTube vars in `.env.example` (UNCOMMITTED)
- Installed `google-auth-library`; built `scripts/youtube-login.js` (loopback OAuth flow, auto-saves `YOUTUBE_REFRESH_TOKEN` to `.env`) — built but **never run**, so the refresh token does not exist yet (untracked, new)
- Invoked `/tjloop` on the YouTube pipeline goal → entered mandatory Align (`grilling`) → asked Q1 of 6 → **interrupted by `/handoff` before TJ answered**

## Files created / changed
- `index.js` — startup catch-up wiring (UNCOMMITTED)
- `src/detectors/index.js` — `runDetectors` takes optional `onProgress` (UNCOMMITTED)
- `src/pipeline.js` — progress-ping wiring + `allDetectorsFailed` fix + new `detectorsRun` field (UNCOMMITTED)
- `.env.example` — documents `YOUTUBE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` (UNCOMMITTED)
- `.env` — real `YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET` (gitignored, not in git status)
- `package.json` / `package-lock.json` — added `google-auth-library` (UNCOMMITTED)
- `unfinishedtasks` — two append passes with this session's state (UNCOMMITTED)
- `ERRORS.md` — new entry on the mark-processed bug (gitignored in this repo — no git diff possible, that's expected)
- `docs/v2-phase2-youtube-architecture.md` — new architecture doc (untracked)
- `scripts/youtube-login.js` — new, not yet run (untracked)
- `--Frag1`, `--Frag2.part` — untracked debris from the yt-dlp bug, repo root — NOT cleaned up, safe to delete, unconfirmed

## Current state
- Vodminer server (pid 19628 at session end) still running OLD code (pre-fix, pre-progress-pings) — TJ explicitly asked to hold off restarting. Verify it's still running before assuming any behavior; don't assume the pid is still valid in a new session.
- ngrok tunnel was live at `https://prerational-smokeless-linwood.ngrok-free.dev` (free tier — rotates on any restart)
- `state/playwright-profile/` now exists — Twitch clip publishing itself is confirmed working on this machine; only audio/motion detection is broken
- `state/processed-vods.json` still lists `2813242741` as processed — stale from the original pre-fix run. The fix stops this going forward but doesn't retroactively un-mark this VOD; remove it manually from that file if the live/catch-up path should ever retry it
- `YOUTUBE_REFRESH_TOKEN` does not exist — `scripts/youtube-login.js` has never been run
- Tests: `npm test` → 37/39 passing; 2 pre-existing failures in `tests/lib/env.test.js`, confirmed unrelated to this session's diff (`env.js` untouched)
- VOD `2813242741`: 0 highlights, 0 clips after two attempts — see Gotchas for confirmed root cause

## Open decisions — need TJ
- [ ] **tjloop Q1 (immediate):** Phase 2a upload — automatic in the live pipeline, or standalone script first (recommended: standalone, mirrors `reprocess-vod.js`)?
- [ ] tjloop Q2–Q6 (not yet asked): human-approval-before-upload? title/description content for v1? test-VOD choice given the 100/day upload quota + multi-hour wall-clock? resumable-upload requirement given this session's yt-dlp reliability issues? confirm download-to-temp-file-then-delete-after-upload flow?
- [ ] The `audioTransient`/`--FragNNN` yt-dlp bug needs a real fix, not another retry — undecided whether this blocks the tjloop or gets a separate fix-first pass
- [ ] Server restart is on hold per TJ's explicit instruction — needs a fresh go-ahead
- [ ] `--Frag1`/`--Frag2.part` cleanup — safe to delete, not yet confirmed
- [ ] `tests/lib/env.test.js` 2 pre-existing failures — fix now or keep deferring?

## Next steps (in order)
1. Resume tjloop Align — TJ answers grilling Q1 (above), then Q2–6, before any Phase 2a code is written.
2. In parallel: decide the fix for the `--FragNNN` yt-dlp bug — likely means changing `audioTransient`'s yt-dlp invocation to avoid piping fragmented downloads through stdout (`-o -`) on Windows, or forcing a non-fragmented format. Needs investigation, not another blind retry.
3. Once Align completes, tjloop converts Phase 2a into a goal doc (matching `docs/v2-phase1-goal.md`'s structure, PREREQUISITE sign-off gate included), then Execute → Challenge → Verify rounds begin.
4. Run `scripts/youtube-login.js` once (TJ opens a URL, logs in as `d0ncorl3one23@gmail.com`) to capture `YOUTUBE_REFRESH_TOKEN` — required before any real upload test.
5. Once TJ confirms it's safe, restart the Vodminer server to pick up the progress-ping + mark-processed-bugfix changes.

## Gotchas / context the next session needs
- **Confirmed reproducible (2/2 attempts), not network flakiness:** `audioTransient` fails with `yt-dlp exit 1` / `ERROR: Unable to download video: [Errno 2] No such file or directory: '--FragNNN'`. Root cause hypothesis: yt-dlp piping a fragmented download to stdout (`-o -`) can't derive real fragment temp-file names, falls back to a bare `--FragNNN`, and something in the Windows path chokes on a filename starting with `--`. Reproduced at different fragment numbers both times. Leaves orphaned `--FragNNN[.part]` files in the repo root each time.
- `motion` detector's 30-min timeout (`config.js` `detector.motion.timeoutMs`) fired correctly both times. `audioTransient` has **no timeout at all** (pre-existing gap) — if it ever hangs instead of erroring, there's no ceiling, ever.
- Two Discord bot connections can run concurrently without conflict (main server + one-off scripts each call `reviewBot.start()` independently) — confirmed working again this session.
- `reprocess-vod.js` never touches `state/processed-vods.json` — safe to run regardless of that file's contents, but won't fix the stale marker either.
- `ERRORS.md` is `.gitignore`d in this repo (line 23) — local-only by design, won't show in `git status`, that's expected.
- Relevant skill for resuming: `/tjloop` is mid-flight, inside its mandatory `grilling` Align step — resume there, don't skip to Execute even though a lot of scoping context already exists in this doc.
- `unfinishedtasks` (repo root) has two detailed session-notes sections appended this session — read those for fuller narrative detail than fits here.
