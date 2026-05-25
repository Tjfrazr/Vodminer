import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';
import { getAllVods } from '../src/twitch/vodFetcher.js';
import { processVod } from '../src/pipeline.js';
import { publishClip, closeContext as closePlaywright } from '../src/twitch/clipPublisher.js';
import reviewBot from '../src/discord/reviewBot.js';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'processed-vods.json');
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const PROFILE_DIR = path.join(STATE_DIR, 'playwright-profile');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY_RUN = args.has('--dry-run');
const SKIP_TWITCH = args.has('--skip-twitch');
const HEADLESS = args.has('--headless');

async function loadJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function saveJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function profileExists() {
  try {
    const s = await stat(PROFILE_DIR);
    return s.isDirectory();
  } catch { return false; }
}

function formatTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

async function main() {
  console.log('--- Backfill: process all VODs ---');
  console.log(`  force=${FORCE}  dryRun=${DRY_RUN}  skipTwitch=${SKIP_TWITCH}  headless=${HEADLESS}\n`);

  if (!SKIP_TWITCH && !(await profileExists())) {
    console.error('Twitch session profile not found at state/playwright-profile/.');
    console.error('Run `node scripts/twitch-login.js` first (one-time interactive login),');
    console.error('or re-run with --skip-twitch to render local clips only.');
    process.exit(1);
  }

  await mkdir(STATE_DIR, { recursive: true });
  const state = await loadJson(STATE_FILE, { processed: [] });
  const processedSet = new Set(state.processed);
  const manifest = await loadJson(MANIFEST_FILE, { clips: [] });
  const manifestSet = new Set(manifest.clips.map((c) => `${c.vodId}:${c.startSec}-${c.endSec}`));

  console.log(`[1/4] Listing all VODs for broadcaster ${env.TWITCH_BROADCASTER_ID}...`);
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

  console.log('[2/4] Starting Discord bot (summary-only mode)...');
  await reviewBot.start();
  console.log('      OK.\n');

  console.log('[3/4] Processing VODs...');
  const startedAt = Date.now();
  let totalRendered = 0;
  let totalTwitchPublished = 0;
  let totalTwitchFailed = 0;
  let totalTiktokDrafts = 0;
  const vodSummaries = [];

  for (const [idx, vod] of targets.entries()) {
    const i = idx + 1;
    console.log(`\n  (${i}/${targets.length}) vodId=${vod.vodId}  duration=${vod.durationSec}s  created=${vod.createdAt}`);
    const vStart = Date.now();
    let vRendered = 0;
    let vPublished = 0;
    let vFailed = 0;

    try {
      const result = await processVod(vod, {
        sendToDiscord: false,
        onClip: async (clip) => {
          vRendered += 1;
          totalRendered += 1;

          let twitchResult = null;
          if (!SKIP_TWITCH) {
            const title = `Highlight @ ${formatTimestamp(clip.startSec)} (${clip.score}σ)`;
            try {
              twitchResult = await publishClip(
                { vodId: vod.vodId, startSec: clip.startSec, endSec: clip.endSec, title },
                { headless: HEADLESS },
              );
              if (twitchResult.published) {
                vPublished += 1;
                totalTwitchPublished += 1;
              } else {
                vFailed += 1;
                totalTwitchFailed += 1;
              }
              if (twitchResult.tiktokDraftSent) totalTiktokDrafts += 1;
            } catch (err) {
              vFailed += 1;
              totalTwitchFailed += 1;
              logger.warn({ err: err?.message, vodId: vod.vodId, clipId: clip.id }, 'twitch publish failed');
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
              createdAt: clip.createdAt,
              twitchClipUrl: twitchResult?.clipUrl ?? null,
              twitchPublished: !!twitchResult?.published,
            });
            manifestSet.add(key);
            await saveJson(MANIFEST_FILE, manifest);
          }
        },
      });

      processedSet.add(vod.vodId);
      state.processed = [...processedSet];
      await saveJson(STATE_FILE, state);

      const took = ((Date.now() - vStart) / 1000).toFixed(1);
      console.log(`        -> ${result.highlights.length} highlights, ${vRendered} rendered, ${vPublished} on Twitch, ${vFailed} failed (${took}s)`);
      vodSummaries.push({ vodId: vod.vodId, rendered: vRendered, published: vPublished, failed: vFailed });
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId }, 'backfill: VOD failed');
      console.log(`        -> FAILED: ${err.message}`);
      vodSummaries.push({ vodId: vod.vodId, error: err.message });
    }
  }

  if (!SKIP_TWITCH) await closePlaywright();

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n[4/4] Done in ${totalSec}s. Rendered ${totalRendered} clips. Twitch published ${totalTwitchPublished}, failed ${totalTwitchFailed}. TikTok drafts ${totalTiktokDrafts}.`);

  if (totalTiktokDrafts > 0) {
    const summary =
      `**Vodminer backfill complete**\n` +
      `TikTok drafts sent: ${totalTiktokDrafts}\n` +
      `VODs processed: ${targets.length}\n` +
      `Highlights detected: ${totalRendered}\n` +
      (SKIP_TWITCH
        ? `Twitch upload: skipped\n`
        : `Twitch clips published: ${totalTwitchPublished}${totalTwitchFailed > 0 ? `  (${totalTwitchFailed} failed)` : ''}\n`) +
      `Elapsed: ${Math.floor(totalSec / 60)}m ${totalSec % 60}s\n` +
      `Manifest: \`clips/highlights-manifest.json\``;

    try {
      await reviewBot.sendSummary(summary);
      console.log('Summary posted to Discord.');
    } catch (err) {
      console.warn('Summary post failed:', err.message);
    }
  } else {
    console.log('No TikTok drafts sent — skipping Discord notification.');
  }

  await reviewBot.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nBACKFILL FAILED:', err.message);
  try { await closePlaywright(); } catch {}
  try { await reviewBot.stop(); } catch {}
  process.exit(1);
});
