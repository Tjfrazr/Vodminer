/**
 * Upload a full VOD to YouTube (Phase 2a/2b, Path A — full edited video):
 * download the whole VOD, trim dead air, generate chapter markers from the
 * bot's own highlight detection, pick a thumbnail, upload as a private video.
 * Standalone script — same "prove it manually before trusting it live"
 * pattern as scripts/reprocess-vod.js.
 *
 * Usage: node scripts/youtube-upload-vod.js <vodId> [gameName...]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { env } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';
import { resolveStreamUrl } from '../src/lib/streamUrl.js';
import { getAllVods, getVodGameName } from '../src/twitch/vodFetcher.js';
import { runDetectors } from '../src/detectors/index.js';
import { mergeHighlights } from '../src/detectors/merge.js';
import { trimSilence, mapToTrimmedTime } from '../src/processing/silenceTrim.js';
import { buildChapters } from '../src/metadata/chapters.js';
import { pickThumbnailFrame } from '../src/thumbnail/frameSelect.js';
import { uploadVideo } from '../src/youtube/uploader.js';
import { getAccessToken } from '../src/youtube/auth.js';
import { hasUploaded, markUploaded } from '../src/lib/youtubeState.js';
import reviewBot from '../src/discord/reviewBot.js';

const vodId = process.argv[2];
const gameNameArg = process.argv.slice(3).join(' ') || null;

if (!vodId) {
  console.error('Usage: node scripts/youtube-upload-vod.js <vodId> [gameName...]');
  process.exit(1);
}

function fmtDate(isoOrDate) {
  const d = new Date(isoOrDate);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Reads the HLS stream directly via ffmpeg (resolveStreamUrl + `-c copy`),
// the same pattern already proven reliable twice this session for the audio
// and motion detectors (270MB in 69s; a full 8GB video scan in ~8min).
// yt-dlp's own downloader was tried here first and stalled at 618MB with
// all three connections stuck in CloseWait, never recovering — a second,
// distinct reliability failure from the earlier `-o -` pipe crash. Direct
// ffmpeg reads have been reliable every time they've been used in this
// codebase; yt-dlp's own downloader has now failed twice.
function downloadFullVod(vodUrl, outPath, { timeoutMs = 4 * 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    resolveStreamUrl(vodUrl, 'best')
      .then((streamUrl) => {
        const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', streamUrl, '-c', 'copy', outPath]);
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ff.kill('SIGKILL');
          reject(new Error(`full VOD download timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        ff.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
        });
      })
      .catch(reject);
  });
}

async function run() {
  if (await hasUploaded('vod', vodId)) {
    console.error(`VOD ${vodId} was already uploaded via this path (state/youtube-uploaded.json). Remove it from that file to force a re-upload.`);
    process.exit(1);
  }

  // Fail fast on a missing/invalid OAuth token before doing any of the
  // expensive work below (full VOD download, silence trim, detection) —
  // otherwise a missing YOUTUBE_REFRESH_TOKEN is only discovered after
  // paying the full cost of the run.
  await getAccessToken();

  const allVods = await getAllVods(env.TWITCH_BROADCASTER_ID);
  const vod = allVods.find((v) => v.vodId === vodId);
  if (!vod) {
    console.error(`VOD ${vodId} not found`);
    process.exit(1);
  }

  let gameName = gameNameArg;
  if (!gameName) {
    gameName = await getVodGameName(vodId).catch(() => null);
  }

  logger.info({ vodId, gameName, durationSec: vod.durationSec }, 'youtube-upload-vod: start');

  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-yt-vod-'));
  const rawPath = path.join(dir, 'raw.mp4');
  const trimmedPath = path.join(dir, 'trimmed.mp4');
  const thumbPath = path.join(dir, 'thumb.jpg');

  try {
    logger.info({ vodId }, 'youtube-upload-vod: downloading full VOD');
    await downloadFullVod(vod.url, rawPath);

    logger.info({ vodId }, 'youtube-upload-vod: trimming dead air');
    const trimResult = await trimSilence(rawPath, trimmedPath);
    logger.info(trimResult, 'youtube-upload-vod: trim done');

    // Reuse the same detectors as the Twitch/TikTok path so chapter
    // placement matches the highlights already being scored for clipping.
    // Detection runs against the ORIGINAL VOD, but the upload is the TRIMMED
    // file -- silence removal re-times everything, so every highlight
    // timestamp must be mapped through the same keepRanges the trim used,
    // or chapters drift further off with every cut and can point at
    // completely the wrong moment (or land past the trimmed runtime).
    logger.info({ vodId }, 'youtube-upload-vod: running detectors for chapter markers');
    const detectorResults = await runDetectors(vod);
    const allHighlights = detectorResults.flatMap((r) => r.highlights);
    const highlights = mergeHighlights(allHighlights, { vod, bannedRanges: [] });
    const trimmedHighlights = highlights
      .map((h) => ({ ...h, startSec: mapToTrimmedTime(h.startSec, trimResult.keepRanges) }))
      .filter((h) => h.startSec !== null);
    const chapters = buildChapters(trimmedHighlights, { totalDurationSec: trimResult.keptDurationSec });

    logger.info({ vodId }, 'youtube-upload-vod: picking thumbnail');
    await pickThumbnailFrame(trimmedPath, thumbPath, { durationSec: trimResult.keptDurationSec });

    const streamDate = fmtDate(vod.createdAt ?? Date.now());
    const title = gameName ? `${gameName} — ${streamDate}` : `Stream — ${streamDate}`;
    const description = [chapters, '', vod.url].filter(Boolean).join('\n');
    const sizeBytes = (await stat(trimmedPath)).size;

    logger.info({ vodId, title, sizeBytes }, 'youtube-upload-vod: uploading');
    const result = await uploadVideo({ filePath: trimmedPath, sizeBytes, title, description, thumbnailPath: thumbPath });

    logger.info({ vodId, ...result }, 'youtube-upload-vod: done');
    console.log(`Uploaded: ${result.videoUrl}`);
    await markUploaded('vod', vodId);

    await reviewBot.start().catch(() => {});
    await reviewBot
      .sendSummary(
        `**YouTube upload complete (VOD ${vodId})** — ${gameName ?? 'unknown'}\n${result.videoUrl}\n(private, pre-audit)`,
      )
      .catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'youtube-upload-vod: fatal');
    process.exit(1);
  });
