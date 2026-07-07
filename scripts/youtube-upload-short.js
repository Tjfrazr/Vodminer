/**
 * Upload a single highlight to YouTube as a vertical Short (Phase 2a/2b,
 * Path B): pick the highest-scoring detected highlight, download just that
 * segment, trim dead air, crop to 9:16, upload as a private Short.
 * Standalone script — same "prove it manually before trusting it live"
 * pattern as scripts/reprocess-vod.js.
 *
 * Usage: node scripts/youtube-upload-short.js <vodId> [gameName...]
 */
import path from 'node:path';
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { env } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';
import { getAllVods, getVodGameName, downloadVodSegment } from '../src/twitch/vodFetcher.js';
import { runDetectors } from '../src/detectors/index.js';
import { mergeHighlights } from '../src/detectors/merge.js';
import { trimSilence } from '../src/processing/silenceTrim.js';
import { pickThumbnailFrame } from '../src/thumbnail/frameSelect.js';
import { uploadVideo } from '../src/youtube/uploader.js';
import { getAccessToken } from '../src/youtube/auth.js';
import { hasUploaded, markUploaded } from '../src/lib/youtubeState.js';
import renderVerticalClip from '../src/processing/ffmpegPipeline.js';
import reviewBot from '../src/discord/reviewBot.js';

const vodId = process.argv[2];
const gameNameArg = process.argv.slice(3).join(' ') || null;

if (!vodId) {
  console.error('Usage: node scripts/youtube-upload-short.js <vodId> [gameName...]');
  process.exit(1);
}

function fmtTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

async function run() {
  if (await hasUploaded('short', vodId)) {
    console.error(`VOD ${vodId} already had a Short uploaded (state/youtube-uploaded.json). Remove it from that file to force a re-upload.`);
    process.exit(1);
  }

  // Fail fast on a missing/invalid OAuth token before doing any of the
  // expensive work below (detection, segment download, crop) — otherwise a
  // missing YOUTUBE_REFRESH_TOKEN is only discovered after paying that cost.
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

  logger.info({ vodId, gameName }, 'youtube-upload-short: running detectors to pick a highlight');
  const detectorResults = await runDetectors(vod);
  const allHighlights = detectorResults.flatMap((r) => r.highlights);
  const highlights = mergeHighlights(allHighlights, { vod, bannedRanges: [] });
  if (highlights.length === 0) {
    console.error(`No highlights detected for VOD ${vodId} — nothing to upload as a Short.`);
    process.exit(1);
  }
  const top = [...highlights].sort((a, b) => b.score - a.score)[0];
  logger.info({ vodId, startSec: top.startSec, endSec: top.endSec, score: top.score }, 'youtube-upload-short: picked highlight');

  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-yt-short-'));
  const rawPath = path.join(dir, 'raw.mp4');
  const trimmedPath = path.join(dir, 'trimmed.mp4');
  const thumbPath = path.join(dir, 'thumb.jpg');
  let croppedPath = null;

  try {
    logger.info({ vodId }, 'youtube-upload-short: downloading segment');
    await downloadVodSegment(vodId, top.startSec, top.endSec, rawPath);

    logger.info({ vodId }, 'youtube-upload-short: trimming dead air');
    const trimResult = await trimSilence(rawPath, trimmedPath);

    logger.info({ vodId }, 'youtube-upload-short: cropping to 9:16');
    // The segment is already isolated to just this highlight and re-timestamped
    // by the silence trim, so the crop step operates on [0, trimmedDuration] —
    // NOT the highlight's original absolute VOD timestamps.
    const cropped = await renderVerticalClip(
      { vodId, startSec: 0, endSec: trimResult.keptDurationSec },
      trimmedPath,
      [],
    );
    croppedPath = cropped.filePath;

    logger.info({ vodId }, 'youtube-upload-short: picking thumbnail');
    await pickThumbnailFrame(croppedPath, thumbPath, { durationSec: cropped.durationSec });

    const title = gameName
      ? `${gameName} highlight @ ${fmtTimestamp(top.startSec)}`
      : `Highlight @ ${fmtTimestamp(top.startSec)}`;
    const description = vod.url;
    const sizeBytes = (await stat(croppedPath)).size;

    logger.info({ vodId, title, sizeBytes }, 'youtube-upload-short: uploading');
    const result = await uploadVideo({ filePath: croppedPath, sizeBytes, title, description, thumbnailPath: thumbPath });

    logger.info({ vodId, ...result }, 'youtube-upload-short: done');
    console.log(`Uploaded: ${result.videoUrl}`);
    await markUploaded('short', vodId);

    await reviewBot.start().catch(() => {});
    await reviewBot
      .sendSummary(
        `**YouTube Short uploaded (VOD ${vodId})** — ${gameName ?? 'unknown'} @ ${fmtTimestamp(top.startSec)}\n${result.videoUrl}\n(private, pre-audit)`,
      )
      .catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (croppedPath) await unlink(croppedPath).catch(() => {});
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'youtube-upload-short: fatal');
    process.exit(1);
  });
