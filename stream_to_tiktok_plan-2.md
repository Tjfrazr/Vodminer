# Stream-to-TikTok Pipeline — Master Plan
**Project:** Automated Twitch → TikTok Highlight System
**Streamer/Lead Developer:** TJ (Ti-Jean Fraser)
**Project Start Date:** May 24 2026
**Constraint:** 100% free — no paid subscriptions or tools

---

## Overview

Read twitch streams and automatically create highlights, clip the highlights and post them to my tictok from Twitch streams, clip them, and post to TikTok — with Discord approve/reject control.

**Goal:** Volume with quality filter — post frequently, but only approved clips go live.
**Review method:** Discord bot notifications with Approve/Reject buttons.
**Content:** Mixed gaming (FPS, Sports, RPG, variety).

---

## Pipeline Architecture (Phase 2 Target)

```
Twitch Stream Ends
       ↓
EventSub Webhook (Node.js) — detects stream.offline
       ↓
Fetch VOD from Twitch API
       ↓
Highlight Detector — audio spike + chat velocity analysis
       ↓
ffmpeg — download clip, crop to 9:16 vertical, add captions
       ↓
Discord Bot (Honeybee-style) — sends preview + Approve/Reject buttons
       ↓
  [Approve] → TikTok Content Posting API → Direct Post
  [Reject]  → Deleted, nothing posted
```

---

## Phase 1 — Validate with Eklipse (Free Tier)
**Timeline: Weeks 1–4**
**Goal: Market research — learn what your audience clips before building a detector**

### Setup Steps
1. Enable "Store past broadcasts" in Twitch Creator Dashboard (Settings → Stream)
2. Create free account at eklipse.gg and connect Twitch
3. Connect TikTok account in Eklipse's Social Accounts panel
4. Set branding template once (overlay/logo)
5. After each stream: spend ~10 minutes reviewing the 15 auto-generated clips, approve the best ones

### What to Track (keep a simple note or spreadsheet)
- Which clip types perform best: reactions, clutch moments, funny fails, chat explosions
- Which games generate the best clips
- What clip length performs best: 15s vs 30s vs 60s
- What time of day TikTok posts perform best

**After 4 streams you'll have real data to design your Phase 2 custom detector around.**

---

## Phase 2 — Build the Custom Node.js Pipeline
**Timeline: After Phase 1**
**Stack: 100% free and open source**

### Tech Stack

| Component | Tool | Cost |
|---|---|---|
| Stream event trigger | Twitch EventSub (webhook) | Free |
| VOD access | Twitch API | Free |
| Highlight detection | Node.js + audio analysis + chat velocity | Free |
| Video processing | ffmpeg | Free/Open Source |
| Clip review | Discord Bot (Honeybee pattern) | Free |
| TikTok posting | TikTok Content Posting API | Free |
| Hosting | Your local machine or free-tier server | Free |

### Component Breakdown

**1. Twitch EventSub Webhook**
- Fires when `stream.offline` event triggers
- Kicks off the full pipeline automatically
- No polling needed — fully event-driven

**2. Twitch VOD API**
- Fetches your broadcast after stream ends
- Lets you pull clips at specific timestamps
- Supports duration range: 5–60 seconds per clip

**3. Highlight Detector (Mixed Gaming)**
- Audio RMS spikes — your mic reacting loudly = highlight moment
- Twitch chat velocity — messages-per-second spike = something happened
- Optional: OpenCV screen motion/brightness detection for visual cues
- Game-specific profiles (tuned using Phase 1 data):
  - FPS: audio spikes + kill-streak chat patterns
  - RPG: dramatic audio + viewer reaction clusters
  - Sports/Racing: crowd audio + chat bursts

**4. ffmpeg Processing**
- Downloads clip segment from VOD
- Crops to 9:16 vertical (center-weighted)
- Burns in optional captions/subtitles
- Exports as MP4 (H.264, 1080p) — TikTok-ready

**5. Discord Bot (Honeybee Pattern)**
- Sends video preview to your Discord
- Two inline buttons: ✅ Post to TikTok | ❌ Skip
- You tap from your phone — even while still streaming
- Queue holds clips until reviewed

**6. TikTok Content Posting API**
- Direct Post mode — goes live immediately on approval
- Supports: caption, hashtags, privacy settings
- Rate limit: 25 videos per account per day
- Upload formats: MP4 + H.264, up to 1GB

### Posting Schedule (Optional Enhancement)
- Don't dump all clips at once after a stream
- Queue approved clips and post at peak TikTok hours: 7pm–10pm
- Space posts ~2–3 hours apart for algorithm visibility

---

## Phase 3 — Refinement
**Timeline: Ongoing**

- Tune the highlight detector using Phase 1 performance data
- Build game-specific detection profiles as your library grows
- Add auto-caption generation (Whisper AI — free, runs locally)
- Add TikTok analytics polling to close the feedback loop (what performed → what to clip more of)

---

## ⚠️ Critical Pre-Phase 2 Task: TikTok Developer App Approval

TikTok requires a registered developer app before their API can post to real accounts.

**Steps:**
1. Register at developers.tiktok.com
2. Create an app and apply for the `video.publish` scope (Content Posting API)
3. Provide a **privacy policy URL** — needs a simple one-page site
4. Submit use case description: "Personal content scheduler — posts gaming highlights from my own Twitch streams to my own TikTok account"
5. Wait for review: **2–6 weeks** (TikTok manually reviews all apps)
6. After approval, unaudited builds post in private-only mode — full public posting requires passing audit

**Start this application during Phase 1 so approval arrives before Phase 2 build begins.**

**Note (2026):** TikTok now requires an `is_ai_generated` boolean flag on API posts. Set to `false` for raw stream footage clips.

---

## Repository Structure (Phase 2)

```
stream-to-tiktok/
├── src/
│   ├── twitch/
│   │   ├── eventSub.js       # Stream offline webhook listener
│   │   ├── vodFetcher.js     # Download VOD segments
│   │   └── clipDetector.js   # Highlight moment detection
│   ├── processing/
│   │   ├── ffmpegPipeline.js # Crop, resize, caption
│   │   └── profiles/         # Game-specific detection configs
│   ├── discord/
│   │   └── reviewBot.js      # Approve/Reject Honeybee-style bot
│   ├── tiktok/
│   │   ├── auth.js           # OAuth 2.0 token management
│   │   ├── uploader.js       # Chunked video upload
│   │   └── poster.js         # Direct Post API call
│   └── scheduler/
│       └── queue.js          # Post timing / queue management
├── .env                      # API keys (gitignored)
├── config.js                 # Game profiles, thresholds
└── index.js                  # Entry point
```

---

## Environment Variables Needed

```
TWITCH_CLIENT_ID= 
TWITCH_CLIENT_SECRET=
TWITCH_BROADCASTER_ID=
TWITCH_WEBHOOK_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_ACCESS_TOKEN=
```

---

## Summary Timeline

| Phase | What | When |
|---|---|---|
| Phase 1 | Eklipse free tier + data collection | Weeks 1–4 |
| TikTok App | Submit developer app for review | Week 1 (parallel) |
| Phase 2 | Build custom Node.js pipeline | After Phase 1 + TikTok approval |
| Phase 3 | Tune detector, add captions, analytics | Ongoing |

---

## Build Agent Team (Claude Code)

**Architecture:** 1 lead agent spawns all sub-agents. The lead holds the full plan, delegates tasks, and merges all output. Sub-agents work in parallel, each in their own context.

**How to start:** Open a Claude Code session, point it at this plan doc and the repo, and instruct it to act as the Project Lead. It will read `CLAUDE.md`, scaffold tasks, and spawn the team.

### Lead Agent

| Agent | Role | Responsibilities |
|---|---|---|
| **Project Lead** | Architect & coordinator | Reads plan doc, breaks work into tasks, spawns all sub-agents, reviews output, maintains `CLAUDE.md`, merges final codebase |

### Core Role Agents (spawned by Lead)

| Agent | Role | Responsibilities |
|---|---|---|
| **Systems Architect** | Designs the structure | Repo scaffold, folder layout, module boundaries, data flow contracts, `.env` schema — runs first before any code |
| **Backend Engineer** | Core pipeline builder | `index.js`, `eventSub.js`, `queue.js`, `scheduler.js` — the Node.js backbone |
| **QA & Testing** | Quality assurance | Jest setup, unit + integration tests for every module, mocked Twitch/TikTok API responses so tests run offline |
| **DevOps** | Runtime & ops | PM2 config, `.env.example`, structured logging, crash recovery, Discord error alerts |

### Feature Specialist Agents (spawned by Lead, run in parallel)

| Agent | Specialty | Files Owned |
|---|---|---|
| **Twitch Specialist** | All things Twitch | `eventSub.js`, `vodFetcher.js`, `clipDetector.js`, `profiles/` |
| **ffmpeg Specialist** | Video processing | `ffmpegPipeline.js`, caption renderer, format validator |
| **Discord Specialist** | Review bot | `reviewBot.js`, inline keyboards, approve/reject callback handlers |
| **TikTok Specialist** | TikTok integration | `auth.js`, `uploader.js`, `poster.js`, OAuth token refresh |

### Build Order

```
1. Project Lead reads plan + scaffolds tasks
       ↓
2. Systems Architect runs first — sets up repo structure
       ↓
3. All specialists + Backend Engineer run in parallel
   (Twitch · ffmpeg · Discord · TikTok · Backend)
       ↓
4. QA & Testing runs alongside — writes tests as modules complete
5. DevOps runs alongside — sets up runtime as modules complete
       ↓
6. Project Lead reviews, resolves conflicts, merges final codebase
```

### CLAUDE.md Essentials (Project Lead maintains this)

The `CLAUDE.md` file at the repo root tells every agent the ground rules:
- Stack: Node.js 20+, ES modules, no TypeScript
- All API keys via `.env` — never hardcoded
- ffmpeg must be installed on host machine
- Twitch EventSub requires a public HTTPS URL (use ngrok for local dev)
- TikTok posts require `is_ai_generated: false`
- Discord channel ID: `6590249760`
- All video output: MP4, H.264, 1080x1920 (9:16), max 60s

---

## Summary Timeline

| Phase | What | When |
|---|---|---|
| Phase 1 | Eklipse free tier + data collection | Weeks 1–4 |
| TikTok App | Submit developer app for review | Week 1 (parallel) |
| Phase 2 Build | Spin up agent team, build pipeline | After Phase 1 + TikTok approval |
| Phase 3 | Tune detector, add captions, analytics | Ongoing |

---

*Plan created: May 2026 | Stack: Node.js + ffmpeg + Twitch API + TikTok API + Discord Bot API*
