import { env } from '../src/lib/env.js';
import { getLatestVod } from '../src/twitch/vodFetcher.js';
import detectClips from '../src/twitch/clipDetector.js';

async function main() {
  console.log('--- L2: Detector test (audio-RMS on real VOD) ---\n');

  console.log('[1/2] Fetching latest VOD...');
  const vod = await getLatestVod(env.TWITCH_BROADCASTER_ID);
  if (!vod) throw new Error('No VOD found for broadcaster.');
  console.log(`      vodId=${vod.vodId}  duration=${vod.durationSec}s  url=${vod.url}\n`);

  console.log('[2/2] Running detectClips() — yt-dlp pipes audio to ffmpeg, computes RMS windows...');
  const startedAt = Date.now();
  const highlights = await detectClips(vod);
  const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`      Done in ${tookSec}s. Returned ${highlights.length} highlight(s).\n`);

  if (highlights.length === 0) {
    console.log('      No highlights detected. Either:');
    console.log('        - The VOD is too quiet / uniform (no audio spikes above 2 stddev)');
    console.log('        - Threshold (config.detector.spikeStddevs) is too strict');
    console.log('        - The VOD is too short to compute meaningful stats');
    return;
  }

  console.log('      Top highlights (sorted by spike strength):');
  for (const [i, h] of highlights.entries()) {
    console.log(
      `      ${String(i + 1).padStart(2, ' ')}. ` +
      `t=${String(h.startSec).padStart(4, ' ')}s..${String(h.endSec).padStart(4, ' ')}s  ` +
      `score=${String(h.score).padStart(5, ' ')}  ` +
      `spikeAt=${h.spikeAtSec}s`,
    );
  }

  console.log('\nL2 passed. yt-dlp + ffmpeg can read the VOD; detector returns sane highlights.');
}

main().catch((err) => {
  console.error('\nL2 FAILED:', err.message);
  if (err.message?.includes('yt-dlp')) {
    console.error('  -> yt-dlp call failed. Is yt-dlp on PATH? Is the VOD URL reachable?');
  } else if (err.message?.includes('ffmpeg')) {
    console.error('  -> ffmpeg call failed. Is ffmpeg on PATH?');
  }
  process.exit(1);
});
