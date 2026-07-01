# Vodminer v2 — Phase 1 Goal: Detection Registry + Motion Detector

## Goal

Turn detection from a hardcoded audio+viewer merge into a **plug-in detector
registry**, and prove the seam by adding one new **ffmpeg motion/scene-intensity
detector** — with zero regression to existing behavior.

## Why now

Mic off + chat off means today's game-audio detector is the weakest link. The
registry is the enabling layer for every future signal (OCR, etc.), and motion
is the laziest real visual signal to add first. Fully local and free — no
external API, so it's verifiable to a hard 9.5 without waiting on Google/TikTok
approvals.

## Done means (Verifier scores against these)

1. **Registry** — detectors are a list of `async (vod) => DetectedHighlight[]`
   functions. Adding one is push-to-array; no edits to merge/pipeline core.
   Existing audio-transient and viewer-clip logic become two registry entries.
2. **Generic merge/rank** — replaces `mergeViewerClips` (pipeline.js:91),
   preserving today's behavior exactly: viewer clips prioritized, overlap
   dedup, banned-range filtering, cap at `maxHighlightsPerVod`, time-sorted.
3. **Motion detector** — ffmpeg-native (`select=gt(scene,N)` on a downscaled /
   low-fps decode), returns `{ startSec, endSec, score, reason: 'motion' }`,
   wired into the registry.
4. **No regression** — Twitch-clip → TikTok-draft → Discord-review flow works
   unchanged; `processVod` still returns `{ vod, highlights, clips }`.
5. **Tests** — merge/rank logic and motion-output parsing have runnable checks;
   `npm test` green.

## Central risk (do not hand-wave)

Scanning a full multi-hour VOD for motion may be too slow/heavy. The loop must
confront this on the laziness ladder (downscale, low fps, sampling) and prove
acceptable time/resource on a representative VOD — not assume it's fine.

## Out of scope (each its own later loop)

YouTube destination, OCR event detection, feedback/learning loop, SQLite,
metadata generation, highlight compilation.

## Captured for Phase 2 — YouTube (do not lose)

- **Discord caption prompt:** before posting a YouTube Short, the Discord bot
  must prompt TJ to enter a caption (text-input modal) — added ahead of the
  upload step, reusing the existing approve/reject bot.
- **Credentials for Phase 2 start:**
  - Twitch — already wired in existing env (`TWITCH_CLIENT_ID/SECRET/
    BROADCASTER_ID`); nothing new.
  - YouTube — needs a Google Cloud project + YouTube Data API v3 enabled +
    OAuth client credentials (not a bare API key). Exact setup steps provided
    at Phase 2 kickoff; stored in git secrets.
- **Phase 1 needs no keys** — motion detector is pure yt-dlp + ffmpeg.

## Permanently dropped

TypeScript rewrite, chat-velocity detector, ML viral-score model, Kafka/Redis
queue, GPU CV pipeline, S3 storage, microservice split.

---

## Execution requirements (dream team is integral, not decorative)

Every tjloop round MUST exercise these roles — especially DA and ponytail:

- **ponytail (Executor):** state the ladder rung before coding
  (`approach / rung / ruled out`); prefer ffmpeg-native `select=gt(scene,N)`
  over hand-rolled motion; no speculative abstraction in the registry.
  `/ponytail-review` run on the diff each round.
- **Devil's Advocate:** fresh subagent attacks each round — motion-scan cost,
  merge/rank regression, leaky abstraction. Any unresolved **Critical** DA
  finding caps the score < 9.5 regardless of weighted total.
- **superpowers:** owns the plan. **Verifier:** fresh subagent, scores to the
  9.5 floor, checks claims against the artifact (never self-graded).

## RESULT — Phase 1 complete (tjloop PASS 9.7/10)

Delivered: `src/detectors/` registry (`index.js` + `audioDetector`, `viewerClipDetector`,
`motionDetector`, `merge`); `config.js` `detector.motion` block; `src/pipeline.js`
uses `runDetectors` + `mergeHighlights` (−76 lines). Suite: 8 files / 39 tests green.

**Central-risk benchmark (compute proven).** Exact detector filter
`fps=2,scale=192,select=gt(scene\,0.4),metadata=print` on generated 1080p:
12s → 0.09s and 300s → 2.55s (~118–130× realtime, linear; Verifier independently
reproduced ~258× on its box). A 4-hour VOD ≈ ~1–2 min ffmpeg compute. Download
reuses the in-production `yt-dlp -o - | ffmpeg -i pipe:0` streaming pattern from
`clipDetector.js`, bounded by `detector.motion.timeoutMs` (30 min). Residual
unknown: real private-VOD download wall-clock — confirm on a live VOD.

**DA findings resolution:** H1 (timeout), H2 (dual-kill/single-settle), M1
(scoreScale 10→5), M4 (per-detector failure → `detectorsFailed` → Discord line),
L2 (stderr cap), L3a (tests added) — all fixed. Accepted-risk: M2 (sequential
double download; single shared decode is the upgrade path), M3 (tune
`sceneThreshold` on a real VOD), L1 (pre-existing, identical old behavior),
L4 (`ffmpegPipeline.js` dead code).

**Follow-ups for later loops:** clipDetector.js has the same latent no-timeout
hang (H1/H2 class) — apply the same guard; consider a shared killable-child
helper (DA alt #2); single shared decode feeding audio+motion (M2).

## PREREQUISITE — sign-off gate (hard rule)

**tjloop execution on this goal is BLOCKED until TJ signs off on this file.**

- No detector-registry code, no motion detector, no `mergeViewerClips` changes
  until sign-off is given.
- Sign-off = TJ explicitly approves this goal (e.g. "go" / "approved").
- Reorder or scope changes must be edited into this file and re-approved before
  tjloop starts.
