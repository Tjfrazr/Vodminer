import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getViewerClipsForVod } from '../twitch/vodFetcher.js';
import { detector as detectorCfg, video as videoCfg } from '../../config.js';

// Titles our own auto-created clips use — excluded so we don't re-clip ourselves.
const AUTO_TITLE_PATTERNS = [
  /^Vodminer test/i,
  /highlight @ \d/i,
  /^Title$/i,
];

export function isOurAutoClip(vc) {
  if (!vc?.title) return false;
  return AUTO_TITLE_PATTERNS.some((re) => re.test(vc.title));
}

export function expandViewerClipToTarget(vc, vodDurationSec) {
  const minLen = detectorCfg.minClipLengthSec;
  const maxLen = Math.min(detectorCfg.maxClipLengthSec, videoCfg.maxDurationSec);
  const targetLen = Math.max(minLen, Math.min(maxLen, vc.durationSec + detectorCfg.preRollSec + detectorCfg.postRollSec));
  const center = vc.vodOffsetSec + vc.durationSec / 2;
  let startSec = Math.max(0, Math.floor(center - targetLen / 2));
  let endSec = startSec + targetLen;
  if (vodDurationSec && endSec > vodDurationSec) {
    endSec = vodDurationSec;
    startSec = Math.max(0, endSec - targetLen);
  }
  return { startSec, endSec };
}

// Viewer clips are strong signal (a human already picked the moment), so they
// score ~999+ to outrank algorithmic detectors in the merge.
async function detect(vod) {
  // Fetch failures propagate to runDetectors' single catch → recorded as a
  // failed detector (surfaced in the Discord summary), pipeline continues.
  const viewerClips = await getViewerClipsForVod(env.TWITCH_BROADCASTER_ID, vod.vodId);
  const real = viewerClips.filter((vc) => !isOurAutoClip(vc));
  logger.info({ vodId: vod.vodId, viewerTotal: viewerClips.length, viewerReal: real.length }, 'viewerClipDetector.done');
  return real.map((vc) => {
    const { startSec, endSec } = expandViewerClipToTarget(vc, vod.durationSec);
    return {
      vodId: vod.vodId,
      startSec,
      endSec,
      score: 999 + (vc.viewCount || 0),
      reason: 'viewer_clip',
      viewerClipId: vc.clipId,
      viewerClipTitle: vc.title,
    };
  });
}

export default { name: 'viewerClip', detect };
