import express from 'express';
import { env } from './src/lib/env.js';
import { logger } from './src/lib/logger.js';
import { assertHostReady } from './src/lib/healthcheck.js';
import { installGlobalHandlers } from './src/lib/alerts.js';
import { createEventSubRouter } from './src/twitch/eventSub.js';
import reviewBot from './src/discord/reviewBot.js';
import { runPipeline, getUnprocessedVods } from './src/pipeline.js';

const app = express();

const { router: eventSubRouter, emitter: twitchEvents } = createEventSubRouter();
twitchEvents.on('stream.offline', (payload) => {
  runPipeline(payload).catch((err) => logger.warn({ err: err?.message }, 'pipeline.unhandled'));
});
app.use('/twitch', eventSubRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown.start');

  if (server) await new Promise((resolve) => server.close(resolve));
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

async function runStartupCatchup() {
  try {
    const vods = await getUnprocessedVods(env.TWITCH_BROADCASTER_ID);
    if (vods.length === 0) {
      logger.info('startup.catchup.none');
      return;
    }
    logger.info({ count: vods.length, vodIds: vods.map((v) => v.vodId) }, 'startup.catchup.found');
    for (const vod of vods) {
      await runPipeline({ broadcasterId: env.TWITCH_BROADCASTER_ID, vod });
    }
  } catch (err) {
    logger.warn({ err: err?.message }, 'startup.catchup.failed');
  }
}

export async function main() {
  await assertHostReady();
  installGlobalHandlers();
  await reviewBot.start();
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server.listening');
  });
  runStartupCatchup();
  return { app, server, reviewBot };
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  main().catch((err) => {
    logger.warn({ err: err?.message }, 'main.fatal');
    process.exit(1);
  });
}

export default main;
