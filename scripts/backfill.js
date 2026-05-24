import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';
import { getAllVods } from '../src/twitch/vodFetcher.js';
import { processVod } from '../src/pipeline.js';
import reviewBot from '../src/discord/reviewBot.js';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'processed-vods.json');
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const SKIP_DISCORD = args.has('--skip-discord');
const DRY_RUN = args.has('--dry-run');

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  console.log('--- Backfill: process all VODs ---');
  console.log(`  force=${FORCE}  skipDiscord=${SKIP_DISCORD}  dryRun=${DRY_RUN}\n`);

  await mkdir(STATE_DIR, { recursive: true });
  const state = await loadJson(STATE_FILE, { processed: [] });
  const processedSet = new Set(state.processed);
  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const manifestSet = new Set(manifest.clips.map((c) => `${c.vodId}:${c.startSec}-${c.endSec}`));

  console.log(`[1/3] Listing all VODs for broadcaster ${env.TWITCH_BROADCASTER_ID}...`);
  const allVods = await getAllVods(env.TWITCH_BROADCASTER_ID, {
    onPage: ({ page, batchSize, total }) =>
      console.log(`      page ${page}: +${batchSize} VODs (total ${total})`),
  });
  console.log(`      total VODs available: ${allVods.length}`);

  const targets = FORCE ? allVods : allVods.filter((v) => !processedSet.has(v.vodId));
  console.log(`      already processed: ${allVods.length - targets.length}`);
  console.log(`      to process now:    ${targets.length}\n`);

  if (targets.length === 0) {
    console.log('Nothing to do. Pass --force to reprocess.');
    return;
  }

  if (DRY_RUN) {
    console.log('[dry-run] Would process:');
    for (const v of targets) {
      console.log(`  vodId=${v.vodId}  duration=${v.durationSec}s  created=${v.createdAt}`);
    }
    return;
  }

  if (!SKIP_DISCORD) {
    console.log('[2/3] Starting Discord bot...');
    await reviewBot.start();
    console.log('      OK.\n');
  } else {
    console.log('[2/3] Skipping Discord (--skip-discord).\n');
  }

  console.log('[3/3] Processing VODs...');
  let totalClips = 0;
  let totalDelivered = 0;
  const startedAt = Date.now();

  for (const [idx, vod] of targets.entries()) {
    const i = idx + 1;
    console.log(`\n  (${i}/${targets.length}) vodId=${vod.vodId}  duration=${vod.durationSec}s  created=${vod.createdAt}`);
    const vStart = Date.now();
    try {
      const result = await processVod(vod, {
        sendToDiscord: !SKIP_DISCORD,
        onClip: async (clip) => {
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
              createdAt: clip.createdAt,
            });
            manifestSet.add(key);
            await saveJson(MANIFEST_FILE, manifest);
          }
        },
      });
      totalClips += result.clips.length;
      totalDelivered += result.delivered;
      processedSet.add(vod.vodId);
      state.processed = [...processedSet];
      await saveJson(STATE_FILE, state);
      const took = ((Date.now() - vStart) / 1000).toFixed(1);
      console.log(`        -> ${result.highlights.length} highlights, ${result.clips.length} rendered, ${result.delivered} delivered (${took}s)`);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'backfill: VOD failed');
      console.log(`        -> FAILED: ${err.message}`);
    }
  }

  if (!SKIP_DISCORD) await reviewBot.stop();

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${totalSec}s. Rendered ${totalClips} clips across ${targets.length} VODs. Delivered ${totalDelivered} to Discord.`);
  console.log(`State: ${STATE_FILE}`);
  console.log(`Manifest: ${MANIFEST_FILE}  (use these timestamps to create native Twitch Highlights in Video Producer)`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nBACKFILL FAILED:', err.message);
  try { await reviewBot.stop(); } catch {}
  process.exit(1);
});
