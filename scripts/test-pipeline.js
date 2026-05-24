import { env } from '../src/lib/env.js';
import reviewBot from '../src/discord/reviewBot.js';
import { runPipeline } from '../src/pipeline.js';

async function main() {
  console.log('--- L4: Full pipeline fake-trigger test ---\n');
  console.log('Mimics what happens when Twitch sends a stream.offline webhook.');
  console.log('Will: detect highlights -> download segments -> render 9:16 clips -> post to Discord.\n');

  console.log('[1/3] Starting Discord bot...');
  await reviewBot.start();
  console.log('      OK.\n');

  console.log(`[2/3] Running pipeline for broadcaster ${env.TWITCH_BROADCASTER_ID}...`);
  const startedAt = Date.now();
  const result = await runPipeline({ broadcasterId: env.TWITCH_BROADCASTER_ID });
  const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`      Done in ${tookSec}s.`);
  console.log(`      VOD:        ${result.vod?.vodId ?? 'none'}`);
  console.log(`      Highlights: ${result.highlights.length}`);
  console.log(`      Delivered:  ${result.delivered} (posted to Discord)\n`);

  console.log('[3/3] Shutting down...');
  await reviewBot.stop();
  console.log('      OK.\n');

  if (result.delivered > 0) {
    console.log(`L4 passed. ${result.delivered} clip(s) posted to your Discord channel — go check.`);
  } else {
    console.log('L4 ran but delivered 0 clips. Possible causes:');
    console.log('  - No VOD on the broadcaster');
    console.log('  - Detector returned 0 highlights');
    console.log('  - Every clip render or send threw (check the logs above for pipeline.clipError)');
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nL4 FAILED:', err.message);
  try { await reviewBot.stop(); } catch {}
  process.exit(1);
});
