import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { getLatestVod, getViewerClipsForVod, getVodGameName } from './twitch/vodFetcher.js';
import detectClips from './twitch/clipDetector.js';
import { detector as detectorCfg, video as videoCfg } from '../config.js';
import reviewBot from './discord/reviewBot.js';
import { publishClip, closeContext as closePlaywright } from './twitch/clipPublisher.js';

reviewBot.onApprove(async ({ clipId, vodId, startSec, endSec, gameName }) => {
  const title = buildClipTitle(gameName, startSec);
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

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'processed-vods.json');
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

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function expandViewerClipToTarget(vc, vodDurationSec) {
  const minLen = detectorCfg.minClipLengthSec;
  const maxLen = Math.min(detectorCfg.maxClipLengthSec, videoCfg.maxDurationSec);
  const targetLen = Math.max(minLen, Math.min(maxLen, vc.durationSec + detectorCfg.preRollSec + detectorCfg.postRollSec));
  const center = vc.vodOffsetSec + vc.durationSec / 2;
  let startSec = Math.max(0, Math.floor(center - targetLen / 2));
  let endSec = startSec + targetLen;
  if (vodDurationSec && endSec > vodDurationSec) {
    endSec = vodDurationSec;
    startSec = Math.max(0, endSec - targetLen);
  }
  return { startSec, endSec };
}

const AUTO_TITLE_PATTERNS = [
  /^Vodminer test/i,
  /highlight @ \d/i,
  /^Title$/i,
];

function buildClipTitle(gameName, startSec) {
  const ts = formatTimestamp(startSec);
  return gameName ? `${gameName} highlight @ ${ts}` : `Highlight @ ${ts}`;
}

function isOurAutoClip(vc) {
  if (!vc?.title) return false;
  return AUTO_TITLE_PATTERNS.some((re) => re.test(vc.title));
}

function mergeViewerClips(audioHighlights, viewerClips, vod) {
  const out = [];
  const seen = [];
  const filtered = viewerClips.filter((vc) => !isOurAutoClip(vc));
  for (const vc of filtered) {
    const { startSec, endSec } = expandViewerClipToTarget(vc, vod.durationSec);
    out.push({
      vodId: vod.vodId,
      startSec,
      endSec,
      score: 999 + (vc.viewCount || 0),
      reason: 'viewer_clip',
      viewerClipId: vc.clipId,
      viewerClipTitle: vc.title,
    });
    seen.push({ startSec, endSec });
  }
  for (const h of audioHighlights) {
    const mid = (h.startSec + h.endSec) / 2;
    const overlap = seen.some((s) => mid >= s.startSec - 15 && mid <= s.endSec + 15);
    if (!overlap) out.push(h);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, detectorCfg.maxHighlightsPerVod)
    .sort((a, b) => a.startSec - b.startSec);
}

export async function processVod(vod, { onClip, gameName: passedGameName = null } = {}) {
  const audioHighlights = (await detectClips(vod)) ?? [];
  let viewerClips = [];
  try {
    viewerClips = await getViewerClipsForVod(env.TWITCH_BROADCASTER_ID, vod.vodId);
  } catch (err) {
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.viewerClipsFetchFailed');
  }
  const realViewerClips = viewerClips.filter((vc) => !isOurAutoClip(vc));
  const highlights = mergeViewerClips(audioHighlights, viewerClips, vod);
  let gameName = passedGameName;
  if (!gameName) {
    try {
      gameName = await getVodGameName(vod.vodId);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.gameNameFetchFailed');
    }
  }
  logger.info(
    {
      vodId: vod.vodId,
      audio: audioHighlights.length,
      viewerTotal: viewerClips.length,
      viewerReal: realViewerClips.length,
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
        viewerClipTitle: h.viewerClipTitle ?? null,
      };
      clips.push(clip);
      if (typeof onClip === 'function') await onClip(clip);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'pipeline.clipError');
    }
  }

  return { vod, highlights, clips };
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

export async function runPipeline(eventPayload) {
  const broadcasterId = eventPayload?.broadcasterId || env.TWITCH_BROADCASTER_ID;
  logger.info({ broadcasterId }, 'pipeline.start');

  const vod = await waitForNewVod(broadcasterId);
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

  try {
    gameName = await reviewBot.askGameName(vod.vodId, gameName);
  } catch (err) {
    logger.warn({ err: err?.message }, 'pipeline.gameNameAskFailed');
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

  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const manifestSet = new Set(manifest.clips.map((c) => `${c.vodId}:${c.startSec}-${c.endSec}`));

  let rendered = 0;
  let published = 0;
  let failed = 0;
  let tiktokDrafts = 0;

  let result = null;
  let pipelineError = null;
  try {
    result = await processVod(vod, {
      gameName,
      onClip: async (clip) => {
        rendered += 1;
        let twitchResult = null;
        if (!skipTwitch) {
          const title = buildClipTitle(clip.gameName, clip.startSec);
          try {
            twitchResult = await publishClip(
              { vodId: vod.vodId, startSec: clip.startSec, endSec: clip.endSec, title },
              { headless: true, skipTikTok: env.SKIP_TIKTOK_DRAFTS },
            );
            if (twitchResult.published) published += 1;
            else failed += 1;
            if (twitchResult.tiktokDraftSent) tiktokDrafts += 1;
          } catch (err) {
            failed += 1;
            logger.warn({ err: err?.message, vodId: vod.vodId, clipId: clip.id }, 'pipeline.twitchPublishFailed');
          }
        }

        const key = `${vod.vodId}:${clip.startSec}-${clip.endSec}`;
        if (!manifestSet.has(key)) {
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
            viewerClipTitle: clip.viewerClipTitle ?? null,
            createdAt: clip.createdAt,
            twitchClipUrl: twitchResult?.clipUrl ?? null,
            twitchPublished: !!twitchResult?.published,
          });
          manifestSet.add(key);
          await saveJson(MANIFEST_FILE, manifest);
        }

        await reviewBot.sendClipRating({
          clipId: clip.id,
          gameName: clip.gameName,
          startSec: clip.startSec,
          score: clip.score,
          reason: clip.reason,
          viewerClipTitle: clip.viewerClipTitle,
          twitchClipUrl: twitchResult?.clipUrl ?? null,
          vodId: vod.vodId,
        }).catch((err) => logger.warn({ err: err?.message }, 'pipeline.ratingMessageFailed'));
      },
    });
  } catch (err) {
    pipelineError = err;
    logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.detectFailed');
  }

  if (!pipelineError) {
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
    : `**Vodminer auto-clip complete (VOD ${vod.vodId})**${gameName ? `  —  ${gameName}` : ''}\n` +
      `TikTok drafts sent: ${tiktokDrafts}\n` +
      `Highlights detected: ${rendered}\n` +
      (skipTwitch
        ? `Twitch upload: skipped (no playwright profile)\n`
        : `Twitch clips published: ${published}${failed > 0 ? `  (${failed} failed)` : ''}\n`) +
      `Manifest: \`clips/highlights-manifest.json\``;

  try {
    await reviewBot.sendSummary(summary);
  } catch (err) {
    logger.warn({ err: err?.message }, 'pipeline.summaryFailed');
  }

  if (pipelineError) {
    return { vod, highlights: [], clips: [], rendered: 0, published: 0, failed: 0, error: pipelineError.message };
  }
  return { vod, highlights: result.highlights, clips: result.clips, rendered, published, failed };
}

export default runPipeline;
