# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Vodminer is an automated Twitch → TikTok highlight clipping pipeline. It detects highlights from Twitch VODs (audio spikes + chat velocity), clips them with ffmpeg, sends previews to Discord for approve/reject review, and posts approved clips to TikTok.

See `stream_to_tiktok_plan-2.md` for the full plan and phased timeline.

## Stack & Constraints

- Node.js 20+, ES modules (`"type": "module"` in package.json) — no TypeScript
- ffmpeg must be installed on the host machine
- 100% free tooling — no paid services or subscriptions
- All API keys via `.env` — never hardcoded
- Twitch EventSub requires a public HTTPS URL (use ngrok for local dev)
- TikTok Content Posting API requires an approved developer app with `video.publish` scope
- TikTok posts must set `is_ai_generated: false` for raw stream footage

## Architecture

```
Twitch EventSub (stream.offline webhook)
  → Fetch VOD via Twitch API
  → Highlight detection (audio RMS spikes + chat velocity)
  → ffmpeg processing (crop 9:16, captions, H.264 1080x1920, max 60s)
  → Discord bot preview with Approve/Reject buttons
  → TikTok Content Posting API (Direct Post on approve)
```

### Module Layout

- `src/twitch/` — EventSub webhook listener, VOD fetcher, highlight/clip detector
- `src/processing/` — ffmpeg pipeline (crop, resize, caption) and game-specific detection profiles in `profiles/`
- `src/discord/` — Review bot with inline Approve/Reject buttons (Honeybee pattern)
- `src/tiktok/` — OAuth 2.0 auth, chunked video upload, Direct Post API
- `src/scheduler/` — Post timing queue (space clips 2-3 hours apart, target 7pm-10pm)
- `config.js` — Game profiles, detection thresholds
- `index.js` — Entry point

## Video Output Spec

All clips: MP4, H.264 codec, 1080x1920 (9:16 vertical), max 60 seconds, max 1GB.

## Key API Limits

- TikTok: 25 videos per account per day
- Twitch VOD clips: 5–60 seconds per clip

## Environment Variables

```
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
TWITCH_BROADCASTER_ID
TWITCH_WEBHOOK_SECRET
DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_ACCESS_TOKEN
```
