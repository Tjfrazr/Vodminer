---
description: Boot Vodminer end-to-end (PATH reload, ngrok tunnel, server, EventSub subscription)
---

Boot Vodminer for live use. Idempotent — safe to re-run; existing tunnel and subscription are reused or replaced cleanly.

Do these steps in order, reporting one tight line after each. Stop and report immediately if any step fails — do not push through.

## 0. Detect platform & working directory
On macOS/Linux use the repo root from cwd. On Windows use `c:/Users/Vito/Vodminer` and reload PATH from the registry in every PowerShell call:
```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
```

## 1. PATH binaries
Verify `ffmpeg`, `ffprobe`, `yt-dlp`, `ngrok` all resolve (`which` on macOS/Linux, `Get-Command` on Windows). If any missing, stop and tell user to install (`brew install ffmpeg yt-dlp ngrok` / `winget install Gyan.FFmpeg yt-dlp.yt-dlp ngrok.ngrok`).

## 2. Reuse-or-start ngrok
Query `http://localhost:4040/api/tunnels` for an existing `public_url`. If a URL comes back, reuse it. Otherwise launch `ngrok http 3000` in the background, wait 3 seconds, query again. Save the URL as `$NGROK_URL`. If ngrok's update warning fires (`agent too old`), run `ngrok update` once and retry.

## 3. Reuse-or-start server
Check if port 3000 is already listening. If so, skip. Otherwise launch `npm start` in the background from the Vodminer directory. Tail its log until you see `"server.listening"` (success) or `"main.fatal"` (failure). Timeout 30s.

## 4. Register the EventSub subscription
Run from the Vodminer directory:

```bash
node scripts/register-eventsub.js $NGROK_URL/twitch/webhook
```

The script auto-deletes any stale `stream.offline` subscriptions for this broadcaster before creating a fresh one. The new subscription starts in `webhook_callback_verification_pending` and flips to `enabled` once Twitch hits the callback (≤30s — the server log will print `eventsub verification challenge accepted`).

## 5. Confirm enabled
List subscriptions and verify the one matching `$NGROK_URL/twitch/webhook` is `status=enabled`. If still `pending` after 10s, something is blocking Twitch from reaching the callback (ngrok dead, server not responding, signature mismatch). Report the actual status.

## 6. Report
Print a 4-line status block:

```
server:        http://localhost:3000 (pid <pid>)
ngrok:         <NGROK_URL>
eventsub:      <id> enabled
discord:       Vodminer#8600 in #clip-reviews
```

Then remind user: "Stream on Twitch for ≥60s, end the stream, and watch #clip-reviews. ngrok free tier rotates URL on restart — re-run /vodminer to refresh the subscription."

## Notes
- Background processes started here die when the Claude session ends. For persistent runs use `pm2 start ecosystem.config.cjs`.
- `.env` must exist with all 6 Twitch + Discord credentials.
- Do not commit `.env`, `clips/`, or `logs/`.
