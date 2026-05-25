import { env } from '../src/lib/env.js';
import { getViewerClipsForVod } from '../src/twitch/vodFetcher.js';

const VOD_ID = process.argv[2];
if (!VOD_ID) {
  console.error('Usage: node scripts/test-viewer-clips.js <vodId>');
  process.exit(1);
}

const clips = await getViewerClipsForVod(env.TWITCH_BROADCASTER_ID, VOD_ID);
console.log(`vodId=${VOD_ID}  viewer clips: ${clips.length}`);
for (const c of clips) {
  console.log(`  @${c.vodOffsetSec}s  ${c.durationSec}s  views=${c.viewCount}  "${c.title}"  by ${c.creatorName}`);
}
