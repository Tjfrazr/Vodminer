/**
 * Reprocess a specific VOD: re-detect highlights, publish Twitch clips, send Discord review messages.
 * Usage: node scripts/reprocess-vod.js <vodId> <gameName>
 */
import path from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { env } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';
import { processVod } from '../src/pipeline.js';
import reviewBot from '../src/discord/reviewBot.js';
import { publishClip, closeContext as closePlaywright } from '../src/twitch/clipPublisher.js';
import { buildPreviewClip } from '../src/processing/previewClip.js';
import { detector as detectorCfg } from '../config.js';

const vodId = process.argv[2];
const gameName = process.argv.slice(3).join(' ') || null;

if (!vodId) {
  console.error('Usage: node scripts/reprocess-vod.js <vodId> [gameName...]');
  process.exit(1);
}

const STATE_DIR = path.resolve('state');
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const PROFILE_DIR = path.join(STATE_DIR, 'playwright-profile');

async function loadJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}
async function saveJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
async function profileExists() {
  try { const s = await stat(PROFILE_DIR); return s.isDirectory(); } catch { return false; }
}
function formatTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}
function buildClipTitle(game, startSec) {
  const ts = formatTimestamp(startSec);
  return game ? `${game} highlight @ ${ts}` : `Highlight @ ${ts}`;
}

async function run() {
  // Start Discord bot
  await reviewBot.start();

  // Fetch VOD metadata from Twitch API
  const { getAllVods } = await import('../src/twitch/vodFetcher.js');
  const allVods = await getAllVods(env.TWITCH_BROADCASTER_ID);
  const vod = allVods.find((v) => v.vodId === vodId);
  if (!vod) {
    console.error(`VOD ${vodId} not found`);
    process.exit(1);
  }
  logger.info({ vodId, gameName, durationSec: vod.durationSec }, 'reprocess-vod: start');

  await reviewBot.sendSummary(
    `**Vodminer: reprocessing VOD ${vodId}**\nGame: ${gameName ?? 'unknown'}\nDuration: ${Math.floor(vod.durationSec / 60)}m`,
  ).catch(() => {});

  const skipTwitch = !(await profileExists());
  if (skipTwitch) logger.warn({ vodId }, 'reprocess-vod: no playwright profile — skipping Twitch clip creation');

  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const manifestSet = new Set(manifest.clips.map((c) => `${c.vodId}:${c.startSec}-${c.endSec}`));

  let rendered = 0;
  let published = 0;
  let failed = 0;
  let tiktokDrafts = 0;

  const onDetectorProgress = async ({ name, phase, count, tookMs, error }) => {
    const sec = tookMs != null ? (tookMs / 1000).toFixed(1) : null;
    const msg =
      phase === 'start'
        ? `🔎 Running detector: \`${name}\`...`
        : phase === 'done'
          ? `✅ \`${name}\`: ${count} highlight${count === 1 ? '' : 's'} (${sec}s)`
          : `⚠️ \`${name}\` failed after ${sec}s: ${error}`;
    await reviewBot.sendSummary(msg).catch((err) => logger.warn({ err: err?.message }, 'reprocess-vod: progress notify failed'));
  };

  const result = await processVod(vod, {
    gameName,
    onDetectorProgress,
    onClip: async (clip) => {
      rendered += 1;
      let twitchResult = null;
      if (!skipTwitch) {
        const title = buildClipTitle(gameName, clip.startSec);
        try {
          twitchResult = await publishClip(
            { vodId, startSec: clip.startSec, endSec: clip.endSec, title },
            { headless: true, skipTikTok: env.SKIP_TIKTOK_DRAFTS },
          );
          if (twitchResult.published) published += 1;
          else failed += 1;
          if (twitchResult.tiktokDraftSent) tiktokDrafts += 1;
        } catch (err) {
          failed += 1;
          logger.warn({ err: err?.message, vodId, clipId: clip.id }, 'reprocess-vod: publishClip failed');
        }
      }

      // Skip clips that were already published and sent to Discord
      const key = `${vodId}:${clip.startSec}-${clip.endSec}`;
      const existing = manifest.clips.findIndex((c) => `${c.vodId}:${c.startSec}-${c.endSec}` === key);
      const existingClip = existing >= 0 ? manifest.clips[existing] : null;
      const hasRealClipUrl = existingClip?.twitchClipUrl?.includes('clips.twitch.tv');
      if (hasRealClipUrl) {
        logger.info({ clipId: clip.id, startSec: clip.startSec }, 'reprocess-vod: already has real clip URL, skipping');
        return;
      }

      // Update manifest (overwrite existing entry if present)
      const entry = {
        vodId,
        vodUrl: vod.url,
        clipId: clip.id,
        filePath: clip.filePath,
        startSec: clip.startSec,
        endSec: clip.endSec,
        durationSec: clip.durationSec,
        score: clip.score,
        gameName: gameName ?? null,
        reason: clip.reason ?? null,
        viewerClipTitle: clip.viewerClipTitle ?? null,
        createdAt: clip.createdAt,
        twitchClipUrl: twitchResult?.clipUrl ?? null,
        twitchPublished: !!twitchResult?.published,
      };
      if (existing >= 0) manifest.clips[existing] = entry;
      else manifest.clips.push(entry);
      manifestSet.add(key);
      await saveJson(MANIFEST_FILE, manifest);

      const preview = await buildPreviewClip(vodId, clip.startSec, clip.endSec).catch((err) => {
        logger.warn({ err: err?.message, clipId: clip.id }, 'reprocess-vod: previewClip failed');
        return null;
      });
      try {
        await reviewBot.sendClipRating({
          clipId: clip.id,
          gameName,
          startSec: clip.startSec,
          score: clip.score,
          reason: clip.reason,
          viewerClipTitle: clip.viewerClipTitle,
          twitchClipUrl: twitchResult?.clipUrl ?? null,
          vodId,
          filePath: preview?.filePath ?? null,
        }).catch((err) => logger.warn({ err: err?.message }, 'reprocess-vod: sendClipRating failed'));
      } finally {
        await preview?.cleanup();
      }
    },
  });

  if (!skipTwitch) await closePlaywright().catch(() => {});

  // "0 highlights because every detector crashed" is a failure, not a result —
  // report it as one (same rule runPipeline applies).
  const allDetectorsFailed = result.detectorsRun > 0 && result.detectorsFailed.length === result.detectorsRun;

  const summary = allDetectorsFailed
    ? `**Vodminer reprocess FAILED (VOD ${vodId})**  —  ${gameName ?? 'unknown'}\n` +
      `All detectors failed: ${result.detectorsFailed.join(', ')}`
    : `**Vodminer reprocess complete (VOD ${vodId})**  —  ${gameName ?? 'unknown'}\n` +
      `Highlights: ${rendered}  |  TikTok drafts: ${tiktokDrafts}\n` +
      (skipTwitch
        ? `Twitch upload: skipped (no playwright profile)`
        : `Twitch clips published: ${published}${failed > 0 ? `  (${failed} failed)` : ''}`) +
      (result.detectorsFailed.length ? `\n⚠️ Detectors failed: ${result.detectorsFailed.join(', ')}` : '');

  await reviewBot.sendSummary(summary).catch(() => {});
  logger.info(
    { vodId, rendered, published, failed, tiktokDrafts, detectorsFailed: result.detectorsFailed },
    'reprocess-vod: done',
  );
  process.exit(allDetectorsFailed ? 1 : 0);
}

run().catch((err) => {
  logger.error({ err: err?.message }, 'reprocess-vod: fatal');
  process.exit(1);
});
