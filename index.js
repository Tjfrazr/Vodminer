import express from 'express';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { env } from './src/lib/env.js';
import { logger } from './src/lib/logger.js';
import { assertHostReady } from './src/lib/healthcheck.js';
import { installGlobalHandlers } from './src/lib/alerts.js';
import { createEventSubRouter } from './src/twitch/eventSub.js';
import { getLatestVod, downloadVodSegment } from './src/twitch/vodFetcher.js';
import detectClips from './src/twitch/clipDetector.js';
import processVideo from './src/processing/ffmpegPipeline.js';
import reviewBot from './src/discord/reviewBot.js';
import { post as postToTikTok } from './src/tiktok/poster.js';
import { createQueue } from './src/scheduler/queue.js';

const app = express();

const clipById = new Map();

const queue = createQueue({
  poster: async (job) => {
    const clip = clipById.get(job.clipId);
    if (!clip) throw new Error(`queue.poster: no clip for ${job.clipId}`);
    const result = await postToTikTok(job, clip);
    clipById.delete(job.clipId);
    return result;
  },
});

async function runPipeline(eventPayload) {
  const broadcasterId = eventPayload?.broadcasterId || env.TWITCH_BROADCASTER_ID;
  logger.info({ broadcasterId }, 'pipeline.start');

  const vod = await getLatestVod(broadcasterId);
  if (!vod) {
    logger.warn({ broadcasterId }, 'pipeline.noVod');
    return;
  }

  const highlights = (await detectClips(vod)) ?? [];
  logger.info({ count: highlights.length, vodId: vod.vodId }, 'pipeline.highlights');

  for (const h of highlights) {
    try {
      const sourcePath = path.join(tmpdir(), `vodminer-${vod.vodId}-${h.startSec}-${h.endSec}.mp4`);
      await downloadVodSegment(vod.vodId, h.startSec, h.endSec, sourcePath);
      const clip = await processVideo(h, sourcePath);
      if (!clip) continue;
      clipById.set(clip.id, clip);
      await reviewBot.sendPreview(clip);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'pipeline.clipError');
    }
  }
}

reviewBot.on('approved', (clipId) => {
  const clip = clipById.get(clipId);
  if (!clip) {
    logger.warn({ clipId }, 'approved.clipMissing');
    return;
  }
  queue.enqueue({
    clipId,
    scheduledFor: new Date().toISOString(),
    caption: '',
    hashtags: [],
  });
});

reviewBot.on('rejected', (clipId) => {
  clipById.delete(clipId);
});

const { router: eventSubRouter, emitter: twitchEvents } = createEventSubRouter();
twitchEvents.on('stream.offline', (payload) => {
  runPipeline(payload).catch((err) => logger.warn({ err: err?.message }, 'pipeline.unhandled'));
});
app.use('/twitch', eventSubRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true, queueDepth: queue.size() }));

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown.start');

  if (server) await new Promise((resolve) => server.close(resolve));
  queue.stop();
  try {
    await queue.drain();
  } catch (err) {
    logger.warn({ err: err?.message }, 'shutdown.drainError');
  }
  try {
    await reviewBot.stop();
  } catch (err) {
    logger.warn({ err: err?.message }, 'shutdown.botStopError');
  }
  logger.info('shutdown.complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export async function main() {
  await assertHostReady();
  installGlobalHandlers();
  await reviewBot.start();
  queue.start();
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server.listening');
  });
  return { app, server, queue, reviewBot };
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  main().catch((err) => {
    logger.warn({ err: err?.message }, 'main.fatal');
    process.exit(1);
  });
}

export default main;
