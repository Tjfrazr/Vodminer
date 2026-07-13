import path from 'node:path';
import { mkdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { getLatestVod, getAllVods, getVodGameName } from './twitch/vodFetcher.js';
import { runDetectors } from './detectors/index.js';
import { mergeHighlightsWithReserve } from './detectors/merge.js';
import { filterCombatHighlights, extractFrame } from './detectors/combatFilter.js';
import { categorizeRacingHighlights } from './detectors/racingFilter.js';
import { resolveStreamUrl } from './lib/streamUrl.js';
import { detector as detectorCfg } from '../config.js';
import reviewBot from './discord/reviewBot.js';
import { publishClip, closeContext as closePlaywright } from './twitch/clipPublisher.js';
import { buildPreviewClip } from './processing/previewClip.js';
import { saveReservePool, loadReservePool } from './lib/highlightPool.js';

// Grabs one frame partway into the VOD so the Discord "confirm the game"
// prompt shows what's actually on screen — auto-detect is often wrong or
// "unknown" and a blank text prompt gives no way to eyeball the real game.
// Midpoint (capped at 10min in) dodges intro/loading screens on long VODs
// without needing per-game tuning. Fail-open: any extraction error just
// means the prompt goes out without an image, never blocks the ask.
async function extractGamePreviewFrame(vod) {
  let dir;
  try {
    const streamUrl = await resolveStreamUrl(vod.url, detectorCfg.combatFilter.ytFormat);
    const t = Math.min(vod.durationSec / 2, 600);
    dir = await mkdtemp(path.join(tmpdir(), 'vodminer-preview-'));
    const framePath = path.join(dir, 'preview.jpg');
    await extractFrame(streamUrl, t, framePath);
    return framePath;
  } catch (err) {
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.gamePreviewFrameFailed');
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

reviewBot.onApprove(async ({ clipId, vodId, startSec, endSec, gameName, category }) => {
  const title = buildClipTitle(gameName, startSec, category);
  try {
    const result = await publishClip(
      { vodId, startSec, endSec, title },
      { headless: true, skipTikTok: false },
    );
    logger.info({ clipId, sent: result.tiktokDraftSent }, 'pipeline.approve.tiktok');
    return { sent: result.tiktokDraftSent };
  } catch (err) {
    logger.warn({ err: err?.message, clipId }, 'pipeline.approve.failed');
    return { sent: false };
  } finally {
    await closePlaywright().catch(() => {});
  }
});

// A clip getting deleted (disapproved, or rated below the low-score threshold)
// shouldn't just shrink the count for that VOD — pull the next-best unused
// candidate from the reserve pool so the total stays where it was.
reviewBot.onReplenish(async (vodId) => {
  await replenishClip(vodId).catch((err) => logger.warn({ err: err?.message, vodId }, 'pipeline.replenishFailed'));
});

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'processed-vods.json');
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const BANNED_RANGES_FILE = path.join(STATE_DIR, 'banned-ranges.json');
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

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function buildClipTitle(gameName, startSec, category) {
  const ts = formatTimestamp(startSec);
  const label = category ? category.replaceAll('_', ' ').toLowerCase() : 'highlight';
  return gameName ? `${gameName} ${label} @ ${ts}` : `${label} @ ${ts}`;
}

export async function processVod(vod, { onClip, gameName: passedGameName = null, onDetectorProgress } = {}) {
  const detectorResults = await runDetectors(vod, undefined, { onProgress: onDetectorProgress });
  const allHighlights = detectorResults.flatMap((r) => r.highlights);
  const detectorsFailed = detectorResults.filter((r) => r.error).map((r) => r.name);
  const { banned: bannedRanges = [] } = await loadJson(BANNED_RANGES_FILE, { banned: [] });
  const { accepted: merged, reserve } = mergeHighlightsWithReserve(allHighlights, { vod, bannedRanges });
  let gameName = passedGameName;
  if (!gameName) {
    try {
      gameName = await getVodGameName(vod.vodId);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.gameNameFetchFailed');
    }
  }
  // Keep what lost out to the maxHighlights cap so a clip deleted later
  // (low rating / disapproval) can be replaced from real candidates instead
  // of the pool just shrinking. See lib/highlightPool.js.
  await saveReservePool(
    vod.vodId,
    reserve.length ? { vod: { vodId: vod.vodId, url: vod.url, durationSec: vod.durationSec }, gameName, highlights: reserve } : null,
  );
  // Content-aware pass: for action/fighting games, drop merged candidates whose
  // sampled frames show menus/cutscenes/idle footage instead of combat (see
  // detectors/combatFilter.js — runs against a local Ollama model, no-ops if
  // Ollama isn't reachable or for non-action games). Belt-and-suspenders
  // try/catch even though the filter fails open internally: a filter bug must
  // never kill highlight processing.
  let highlights = merged;
  try {
    highlights = await filterCombatHighlights(merged, { vod, gameName });
  } catch (err) {
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.combatFilterFailed');
  }
  // Racing games: label candidates with a category (crash, overtake, drift, ...)
  // instead of filtering — see detectors/racingFilter.js for why this doesn't drop.
  try {
    highlights = await categorizeRacingHighlights(highlights, { vod, gameName });
  } catch (err) {
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.racingFilterFailed');
  }
  logger.info(
    {
      vodId: vod.vodId,
      byDetector: Object.fromEntries(detectorResults.map((r) => [r.name, r.highlights.length])),
      detectorsFailed,
      merged: merged.length,
      combatFiltered: merged.length - highlights.length,
      total: highlights.length,
    },
    'pipeline.highlights',
  );

  const clips = [];

  for (const h of highlights) {
    try {
      const clip = {
        id: `${vod.vodId}-${h.startSec}-${h.endSec}`,
        startSec: h.startSec,
        endSec: h.endSec,
        durationSec: h.endSec - h.startSec,
        score: h.score,
        createdAt: new Date().toISOString(),
        filePath: null,
        gameName,
        reason: h.reason,
        category: h.category ?? null,
        viewerClipTitle: h.viewerClipTitle ?? null,
      };
      clips.push(clip);
      if (typeof onClip === 'function') await onClip(clip);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'pipeline.clipError');
    }
  }

  return { vod, highlights, clips, detectorsFailed, detectorsRun: detectorResults.length };
}

async function waitForNewVod(broadcasterId, { intervalMs = 30000, timeoutMs = 60 * 60 * 1000 } = {}) {
  const state = await loadJson(STATE_FILE, { processed: [] });
  const processedSet = new Set(state.processed);
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const vod = await getLatestVod(broadcasterId);
    if (vod && !processedSet.has(vod.vodId)) {
      logger.info({ broadcasterId, vodId: vod.vodId, attempt }, 'pipeline.newVodReady');
      return vod;
    }
    logger.info({ broadcasterId, latest: vod?.vodId, attempt }, 'pipeline.waitingForVod');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export async function checkForUnprocessedVod(broadcasterId) {
  const state = await loadJson(STATE_FILE, { processed: [] });
  const processedSet = new Set(state.processed);
  const vod = await getLatestVod(broadcasterId);
  if (vod && !processedSet.has(vod.vodId)) return vod;
  return null;
}

// Unlike checkForUnprocessedVod (latest VOD only), this walks the full VOD
// history so a backlog of older, never-processed VODs actually gets caught
// instead of being silently skipped forever once a newer VOD exists.
export async function getUnprocessedVods(broadcasterId) {
  const state = await loadJson(STATE_FILE, { processed: [] });
  const processedSet = new Set(state.processed);
  const allVods = await getAllVods(broadcasterId);
  return allVods
    .filter((v) => !processedSet.has(v.vodId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// Publishes one clip to Twitch/TikTok (if configured) and sends it to Discord
// for review. Extracted out of runPipeline's onClip callback so replenishClip
// (a clip pulled from the reserve pool well after the original pipeline run
// finished) can go through the exact same publish+manifest+review path
// instead of a second, drifting copy of it.
async function publishAndReviewClip(vod, clip, { skipTwitch = false } = {}) {
  let twitchResult = null;
  if (!skipTwitch) {
    const title = buildClipTitle(clip.gameName, clip.startSec, clip.category);
    try {
      twitchResult = await publishClip(
        { vodId: vod.vodId, startSec: clip.startSec, endSec: clip.endSec, title },
        { headless: true, skipTikTok: env.SKIP_TIKTOK_DRAFTS },
      );
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, clipId: clip.id }, 'pipeline.twitchPublishFailed');
    }
  }

  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const key = `${vod.vodId}:${clip.startSec}-${clip.endSec}`;
  if (!manifest.clips.some((c) => `${c.vodId}:${c.startSec}-${c.endSec}` === key)) {
    manifest.clips.push({
      vodId: vod.vodId,
      vodUrl: vod.url,
      clipId: clip.id,
      filePath: clip.filePath,
      startSec: clip.startSec,
      endSec: clip.endSec,
      durationSec: clip.durationSec,
      score: clip.score,
      gameName: clip.gameName ?? null,
      reason: clip.reason ?? null,
      category: clip.category ?? null,
      viewerClipTitle: clip.viewerClipTitle ?? null,
      createdAt: clip.createdAt,
      twitchClipUrl: twitchResult?.clipUrl ?? null,
      twitchPublished: !!twitchResult?.published,
    });
    await saveJson(MANIFEST_FILE, manifest);
  }

  const preview = await buildPreviewClip(vod.vodId, clip.startSec, clip.endSec).catch((err) => {
    logger.warn({ err: err?.message, clipId: clip.id }, 'pipeline.previewClipFailed');
    return null;
  });
  try {
    await reviewBot.sendClipRating({
      clipId: clip.id,
      gameName: clip.gameName,
      category: clip.category,
      startSec: clip.startSec,
      score: clip.score,
      reason: clip.reason,
      viewerClipTitle: clip.viewerClipTitle,
      twitchClipUrl: twitchResult?.clipUrl ?? null,
      vodId: vod.vodId,
      filePath: preview?.filePath ?? null,
    }).catch((err) => logger.warn({ err: err?.message }, 'pipeline.ratingMessageFailed'));
  } finally {
    await preview?.cleanup();
  }
  return twitchResult;
}

// Pulls the next-best unused candidate from vodId's reserve pool (see
// lib/highlightPool.js) and publishes it exactly like a normal clip, so
// deleting a bad clip doesn't just shrink the count for that VOD. Skips pool
// entries that got banned or already used since the pool was last saved
// (e.g. two disapprovals landing on overlapping candidates), and runs the
// same content filters a normal run would so a replacement doesn't bypass
// the combat/racing checks. No-ops (logs and returns null) once the pool for
// this VOD is exhausted — never invents a highlight that wasn't detected.
export async function replenishClip(vodId) {
  const pool = await loadReservePool(vodId);
  if (!pool?.highlights?.length) {
    logger.info({ vodId }, 'pipeline.replenish.poolEmpty');
    return null;
  }

  const { banned: bannedRanges = [] } = await loadJson(BANNED_RANGES_FILE, { banned: [] });
  const vodBanned = bannedRanges.filter((b) => b.vodId === vodId);
  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const usedRanges = new Set(
    manifest.clips.filter((c) => c.vodId === vodId).map((c) => `${c.startSec}-${c.endSec}`),
  );

  while (pool.highlights.length > 0) {
    const candidate = pool.highlights.shift();
    const overlapsBanned = vodBanned.some((b) => candidate.startSec < b.endSec && candidate.endSec > b.startSec);
    const alreadyUsed = usedRanges.has(`${candidate.startSec}-${candidate.endSec}`);
    if (overlapsBanned || alreadyUsed) continue;

    let survivors = [candidate];
    try {
      survivors = await filterCombatHighlights([candidate], { vod: pool.vod, gameName: pool.gameName });
    } catch (err) {
      logger.warn({ err: err?.message, vodId }, 'pipeline.replenish.combatFilterFailed');
    }
    if (survivors.length === 0) continue; // combat filter dropped it — try the next candidate

    let chosen = survivors[0];
    try {
      const [categorized] = await categorizeRacingHighlights([chosen], { vod: pool.vod, gameName: pool.gameName });
      if (categorized) chosen = categorized;
    } catch (err) {
      logger.warn({ err: err?.message, vodId }, 'pipeline.replenish.racingFilterFailed');
    }

    await saveReservePool(vodId, pool.highlights.length ? pool : null);

    const clip = {
      id: `${vodId}-${chosen.startSec}-${chosen.endSec}`,
      startSec: chosen.startSec,
      endSec: chosen.endSec,
      durationSec: chosen.endSec - chosen.startSec,
      score: chosen.score,
      createdAt: new Date().toISOString(),
      filePath: null,
      gameName: pool.gameName,
      reason: chosen.reason,
      category: chosen.category ?? null,
      viewerClipTitle: chosen.viewerClipTitle ?? null,
    };
    const skipTwitch = !(await profileExists());
    await publishAndReviewClip(pool.vod, clip, { skipTwitch });
    logger.info({ vodId, clipId: clip.id }, 'pipeline.replenish.published');
    return clip;
  }

  await saveReservePool(vodId, null);
  logger.info({ vodId }, 'pipeline.replenish.poolExhausted');
  return null;
}

export async function runPipeline(eventPayload) {
  const broadcasterId = eventPayload?.broadcasterId || env.TWITCH_BROADCASTER_ID;
  logger.info({ broadcasterId }, 'pipeline.start');

  const vod = eventPayload?.vod ?? (await waitForNewVod(broadcasterId));
  if (!vod) {
    logger.warn({ broadcasterId }, 'pipeline.noNewVod');
    return { vod: null, highlights: [], clips: [], rendered: 0, published: 0, failed: 0 };
  }

  const skipTwitch = !(await profileExists());
  if (skipTwitch) {
    logger.warn({ vodId: vod.vodId }, 'pipeline.noPlaywrightProfile');
  }

  let gameName = null;
  try {
    gameName = await getVodGameName(vod.vodId);
  } catch (err) {
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.gameNameFetchFailed');
  }

  const previewImagePath = await extractGamePreviewFrame(vod);
  try {
    gameName = await reviewBot.askGameName(vod.vodId, gameName, { previewImagePath });
  } catch (err) {
    logger.warn({ err: err?.message }, 'pipeline.gameNameAskFailed');
  } finally {
    if (previewImagePath) await rm(path.dirname(previewImagePath), { recursive: true, force: true }).catch(() => {});
  }

  const startSummary =
    `**Vodminer: new VOD detected — processing...**\n` +
    `VOD: \`${vod.vodId}\`${vod.title ? `  —  ${vod.title}` : ''}\n` +
    `Game: ${gameName ?? 'unknown'}\n` +
    `Duration: ${formatDuration(vod.durationSec)}\n` +
    `Started: ${new Date().toISOString()}`;
  try {
    await reviewBot.sendSummary(startSummary);
  } catch (err) {
    logger.warn({ err: err?.message }, 'pipeline.startNotifyFailed');
  }

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
    try {
      await reviewBot.sendSummary(msg);
    } catch (err) {
      logger.warn({ err: err?.message }, 'pipeline.detectorProgressNotifyFailed');
    }
  };

  let result = null;
  let pipelineError = null;
  try {
    result = await processVod(vod, {
      gameName,
      onDetectorProgress,
      onClip: async (clip) => {
        rendered += 1;
        const twitchResult = await publishAndReviewClip(vod, clip, { skipTwitch });
        if (!skipTwitch) {
          if (twitchResult?.published) published += 1;
          else failed += 1;
          if (twitchResult?.tiktokDraftSent) tiktokDrafts += 1;
        }
      },
    });
  } catch (err) {
    pipelineError = err;
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.detectFailed');
  }

  // Every detector erroring out is functionally the same as processVod throwing —
  // no highlights were legitimately evaluated. Treat it like a pipelineError so the
  // VOD stays unmarked and gets retried, instead of being indistinguishable from a
  // VOD that genuinely had zero highlights.
  const allDetectorsFailed =
    !pipelineError && result && result.detectorsRun > 0 && result.detectorsFailed.length === result.detectorsRun;
  if (allDetectorsFailed) {
    logger.warn({ vodId: vod.vodId, detectorsFailed: result.detectorsFailed }, 'pipeline.allDetectorsFailed');
  }

  if (!pipelineError && !allDetectorsFailed) {
    await mkdir(STATE_DIR, { recursive: true });
    const state = await loadJson(STATE_FILE, { processed: [] });
    const processedSet = new Set(state.processed);
    processedSet.add(vod.vodId);
    state.processed = [...processedSet];
    await saveJson(STATE_FILE, state);
  }

  if (!skipTwitch) await closePlaywright().catch(() => {});

  const summary = pipelineError
    ? `**Vodminer auto-clip FAILED (VOD ${vod.vodId})**\n${pipelineError.message}\nVOD not marked processed; will retry on next trigger.`
    : allDetectorsFailed
      ? `**Vodminer auto-clip FAILED (VOD ${vod.vodId})**\nAll detectors failed: ${result.detectorsFailed.join(', ')}\nVOD not marked processed; will retry on next trigger.`
      : `**Vodminer auto-clip complete (VOD ${vod.vodId})**${gameName ? `  —  ${gameName}` : ''}\n` +
        `TikTok drafts sent: ${tiktokDrafts}\n` +
        `Highlights detected: ${rendered}\n` +
        (skipTwitch
          ? `Twitch upload: skipped (no playwright profile)\n`
          : `Twitch clips published: ${published}${failed > 0 ? `  (${failed} failed)` : ''}\n`) +
        (result?.detectorsFailed?.length ? `⚠️ Detectors failed: ${result.detectorsFailed.join(', ')}\n` : '') +
        `Manifest: \`clips/highlights-manifest.json\``;

  try {
    await reviewBot.sendSummary(summary);
  } catch (err) {
    logger.warn({ err: err?.message }, 'pipeline.summaryFailed');
  }

  if (pipelineError || allDetectorsFailed) {
    const error = pipelineError ? pipelineError.message : `all detectors failed: ${result.detectorsFailed.join(', ')}`;
    return { vod, highlights: [], clips: [], rendered: 0, published: 0, failed: 0, error };
  }
  return { vod, highlights: result.highlights, clips: result.clips, rendered, published, failed };
}

export default runPipeline;
