import path from 'node:path';
import { tmpdir } from 'node:os';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { getLatestVod, downloadVodSegment } from './twitch/vodFetcher.js';
import detectClips from './twitch/clipDetector.js';
import processVideo from './processing/ffmpegPipeline.js';
import reviewBot from './discord/reviewBot.js';

export async function processVod(vod, { sendToDiscord = true, onClip } = {}) {
  const highlights = (await detectClips(vod)) ?? [];
  logger.info({ count: highlights.length, vodId: vod.vodId }, 'pipeline.highlights');

  const clips = [];
  let delivered = 0;

  for (const h of highlights) {
    try {
      const sourcePath = path.join(tmpdir(), `vodminer-${vod.vodId}-${h.startSec}-${h.endSec}.mp4`);
      await downloadVodSegment(vod.vodId, h.startSec, h.endSec, sourcePath);
      const clip = await processVideo(h, sourcePath);
      if (!clip) continue;
      clip.startSec = h.startSec;
      clip.endSec = h.endSec;
      clip.score = h.score;
      clips.push(clip);
      if (sendToDiscord) {
        await reviewBot.sendPreview(clip);
        delivered += 1;
      }
      if (typeof onClip === 'function') await onClip(clip);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'pipeline.clipError');
    }
  }

  return { vod, highlights, clips, delivered };
}

export async function runPipeline(eventPayload) {
  const broadcasterId = eventPayload?.broadcasterId || env.TWITCH_BROADCASTER_ID;
  logger.info({ broadcasterId }, 'pipeline.start');

  const vod = await getLatestVod(broadcasterId);
  if (!vod) {
    logger.warn({ broadcasterId }, 'pipeline.noVod');
    return { vod: null, highlights: [], clips: [], delivered: 0 };
  }

  return processVod(vod, { sendToDiscord: true });
}

export default runPipeline;
