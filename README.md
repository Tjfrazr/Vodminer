# Vodminer

Automated Twitch highlight detection and clipping pipeline. After a stream ends, Vodminer analyzes the VOD for exciting moments, creates Twitch Clips, and sends them to Discord for review. Approved clips are queued as TikTok drafts via Twitch's share UI.

## Architecture

```
Twitch EventSub (stream.offline webhook)
  -> Fetch VOD via Twitch API
  -> Highlight detection (audio RMS spike analysis via yt-dlp + ffmpeg)
  -> Create Twitch Clip via Playwright browser automation
  -> Discord bot preview (Approve / Disapprove buttons)
  -> On approve: send to TikTok as a draft via Twitch's share UI
```

## Project Structure

```
index.js                    Entry point (Express server + Discord bot)
config.js                   Detection thresholds and video settings
src/
  twitch/
    eventSub.js             EventSub webhook listener (HMAC-verified)
    vodFetcher.js           VOD metadata + segment download via Twitch API
    clipDetector.js         Audio RMS spike detection (yt-dlp + ffmpeg)
    clipPublisher.js        Playwright automation: Twitch clip editor + TikTok draft
    profiles/               Game-specific detection profiles
  processing/
    ffmpegPipeline.js       ffmpeg pipeline (crop, resize, caption) for local previews
  discord/
    reviewBot.js            Review bot with Approve/Disapprove buttons
  lib/
    env.js                  Environment variable validation
    logger.js               Pino structured logging
    alerts.js               Discord webhook error alerts
    healthcheck.js          Host readiness checks (ffmpeg, yt-dlp, Playwright)
    types.js                JSDoc type definitions
scripts/
  register-eventsub.js      Register Twitch EventSub subscription
  reprocess-vod.js          Reprocess a specific VOD
  backfill.js               Backfill past VODs
  twitch-login.js           Twitch OAuth / Playwright session login helper
  test-*.js                 Manual integration test scripts
```

## Requirements

- Node.js 20+
- ffmpeg and ffprobe (audio analysis and local clip processing)
- yt-dlp (VOD audio download for detection)
- Playwright Chromium (Twitch clip creation and TikTok draft export)
- ngrok (for local development — Twitch EventSub requires a public HTTPS URL)

### Install (macOS)

```bash
brew install ffmpeg yt-dlp ngrok
npm install
npx playwright install chromium
```

### Install (Windows)

```powershell
winget install Gyan.FFmpeg yt-dlp.yt-dlp ngrok.ngrok
npm install
npx playwright install chromium
```

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Source |
|---|---|
| `TWITCH_CLIENT_ID` | [Twitch Developer Console](https://dev.twitch.tv/console/apps) |
| `TWITCH_CLIENT_SECRET` | Same app registration |
| `TWITCH_BROADCASTER_ID` | Twitch API users endpoint for your channel |
| `TWITCH_WEBHOOK_SECRET` | Any random string you generate (10–100 chars) |
| `DISCORD_BOT_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CHANNEL_ID` | Right-click channel in Discord (Developer Mode on) |

2. Log in to Twitch in the Playwright browser profile (one-time):

```bash
node scripts/twitch-login.js
```

3. Start ngrok to get a public URL:

```bash
ngrok http 3000
```

4. Register the EventSub subscription:

```bash
node scripts/register-eventsub.js https://YOUR-NGROK-URL/twitch/webhook
```

5. Start the server:

```bash
npm start
```

## Usage

Once running, the pipeline is fully automatic:

1. Stream on Twitch
2. End your stream — triggers `stream.offline` webhook
3. Vodminer analyzes the VOD audio for highlight moments
4. For each highlight, Playwright opens the Twitch clip editor and creates a Twitch Clip
5. Clips appear in your Discord channel with Approve / Disapprove buttons
6. **Approve**: Playwright sends the clip to TikTok as a draft (appears in TikTok Studio for you to review and post)
7. **Disapprove**: clip is deleted from Twitch and the time range is banned from future detection

## Clip Limits

- Twitch Clips: max 60 seconds
- TikTok: clips land as drafts in TikTok Studio — manual publish required

## License

Private — all rights reserved.
