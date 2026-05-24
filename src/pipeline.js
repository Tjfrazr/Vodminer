import path from 'node:path';
import { tmpdir } from 'node:os';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { getLatestVod, downloadVodSegment } from './twitch/vodFetcher.js';
import detectClips from './twitch/clipDetector.js';
import processVideo from './processing/ffmpegPipeline.js';
import reviewBot from './discord/reviewBot.js';

export async function runPipeline(eventPayload) {
  const broadcasterId = eventPayload?.broadcasterId || env.TWITCH_BROADCASTER_ID;
  logger.info({ broadcasterId }, 'pipeline.start');

  const vod = await getLatestVod(broadcasterId);
  if (!vod) {
    logger.warn({ broadcasterId }, 'pipeline.noVod');
    return { vod: null, highlights: [], delivered: 0 };
  }

  const highlights = (await detectClips(vod)) ?? [];
  logger.info({ count: highlights.length, vodId: vod.vodId }, 'pipeline.highlights');

  let delivered = 0;
  for (const h of highlights) {
    try {
      const sourcePath = path.join(tmpdir(), `vodminer-${vod.vodId}-${h.startSec}-${h.endSec}.mp4`);
      await downloadVodSegment(vod.vodId, h.startSec, h.endSec, sourcePath);
      const clip = await processVideo(h, sourcePath);
      if (!clip) continue;
      await reviewBot.sendPreview(clip);
      delivered += 1;
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.clipError');
    }
  }

  return { vod, highlights, delivered };
}

export default runPipeline;
