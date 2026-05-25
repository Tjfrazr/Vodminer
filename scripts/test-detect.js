import { env } from '../src/lib/env.js';
import { getLatestVod } from '../src/twitch/vodFetcher.js';
import { processVod } from '../src/pipeline.js';

const VOD_ID = process.argv[2];

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s` : `${m}m${String(s).padStart(2, '0')}s`;
}

async function main() {
  let vod;
  if (VOD_ID) {
    // Build a minimal VOD shape so detector + viewer-clip fetch can run.
    vod = {
      vodId: VOD_ID,
      url: `https://www.twitch.tv/videos/${VOD_ID}`,
      durationSec: null,
      createdAt: null,
    };
  } else {
    vod = await getLatestVod(env.TWITCH_BROADCASTER_ID);
    if (!vod) {
      console.error('no VOD found for broadcaster', env.TWITCH_BROADCASTER_ID);
      process.exit(1);
    }
  }
  console.log(`vodId=${vod.vodId}  url=${vod.url}\n`);

  const result = await processVod(vod, {});
  console.log(`\n${result.highlights.length} highlights chosen:\n`);
  for (const [i, h] of result.highlights.entries()) {
    const tag = h.reason === 'viewer_clip' ? '[VIEWER]' : '[audio]';
    const title = h.viewerClipTitle ? `  "${h.viewerClipTitle}"` : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${tag}  ${fmt(h.startSec)}-${fmt(h.endSec)}  score=${h.score}${title}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
