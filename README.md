# Vodminer

Automated Twitch-to-TikTok highlight clipping pipeline. Detects highlights from Twitch VODs using audio spikes and chat velocity, clips them with ffmpeg, sends previews to Discord for review, and posts approved clips to TikTok.

## Architecture

```
Twitch EventSub (stream.offline webhook)
  -> Fetch VOD via Twitch API
  -> Highlight detection (audio RMS spikes + chat velocity)
  -> ffmpeg processing (crop 9:16, captions, H.264 1080x1920)
  -> Discord bot preview (Approve / Disapprove buttons)
  -> TikTok Content Posting API (Direct Post on approve)
```

## Project Structure

```
index.js                    Entry point (Express server + Discord bot)
config.js                   Video output spec + detection thresholds
src/
  twitch/
    eventSub.js             EventSub webhook listener
    vodFetcher.js           VOD download via Twitch API
    clipDetector.js         Audio RMS + chat velocity highlight detection
    clipPublisher.js        Clip metadata and publishing
    profiles/               Game-specific detection profiles
  processing/
    ffmpegPipeline.js       ffmpeg pipeline (crop, resize, caption)
  discord/
    reviewBot.js            Review bot with Approve/Disapprove buttons
  lib/
    env.js                  Environment variable validation
    logger.js               Pino structured logging
    alerts.js               Discord webhook error alerts
    healthcheck.js          Host readiness checks (ffmpeg, yt-dlp)
    types.js                JSDoc type definitions
scripts/
  register-eventsub.js      Register Twitch EventSub subscription
  reprocess-vod.js          Reprocess a specific VOD
  backfill.js               Backfill past VODs
  twitch-login.js           Twitch OAuth helper
  test-*.js                 Manual integration test scripts
```

## Requirements

- Node.js 20+
- ffmpeg and ffprobe
- yt-dlp
- ngrok (for local development — Twitch EventSub requires a public HTTPS URL)

### Install (macOS)

```bash
brew install ffmpeg yt-dlp ngrok
npm install
```

### Install (Windows)

```powershell
winget install Gyan.FFmpeg yt-dlp.yt-dlp ngrok.ngrok
npm install
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
| `TWITCH_WEBHOOK_SECRET` | Any random string you generate |
| `DISCORD_BOT_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CHANNEL_ID` | Right-click channel in Discord (Developer Mode) |

2. Start ngrok to get a public URL:

```bash
ngrok http 3000
```

3. Register the EventSub subscription:

```bash
node scripts/register-eventsub.js https://YOUR-NGROK-URL/twitch/webhook
```

4. Start the server:

```bash
npm start
```

## Usage

Once running, the pipeline is fully automatic:

1. Stream on Twitch
2. End your stream (triggers `stream.offline` webhook)
3. Vodminer fetches the VOD, detects highlights, and clips them
4. Clips appear in your Discord channel with Approve/Disapprove buttons
5. Approved clips are posted to TikTok

## Video Output

All clips: MP4, H.264, 1080x1920 (9:16 vertical), 45-90 seconds, max 1GB.

## API Limits

- TikTok: 25 videos per account per day
- Twitch VOD clips: 5-60 seconds per clip

## License

Private — all rights reserved.
