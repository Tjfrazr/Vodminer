import { detector as detectorCfg } from '../../config.js';
import { logger } from '../lib/logger.js';

const COLLISION_SLOP_SEC = 15;

// A candidate collides with an accepted highlight if the candidate's midpoint
// falls within the accepted range (± slop). This reproduces the old behavior
// where an audio highlight was dropped when its midpoint landed inside a viewer
// clip's window; generalized here to any detector via score-ranked suppression.
function collides(candidate, accepted) {
  const mid = (candidate.startSec + candidate.endSec) / 2;
  return mid >= accepted.startSec - COLLISION_SLOP_SEC && mid <= accepted.endSec + COLLISION_SLOP_SEC;
}

/**
 * Merge highlights from all detectors into a ranked, deduped, capped list.
 * Behavior preserved from the old audio+viewer merge:
 *   - viewer clips (score ~999+) outrank algorithmic detectors and win overlaps
 *   - overlapping lower-scored highlights are suppressed
 *   - banned ranges for this vod are filtered out
 *   - capped at maxHighlights, returned sorted by startSec ascending
 * Generalization: suppression now applies across ALL detectors (and same-source
 * overlaps), so two near-identical clips are no longer both emitted.
 */
export function mergeHighlights(highlights, opts) {
  return mergeHighlightsWithReserve(highlights, opts).accepted;
}

// Same computation as mergeHighlights, but also returns everything that lost
// out to the maxHighlights cap (score-ranked, highest first) instead of
// silently discarding it — see lib/highlightPool.js for why that tail is
// worth keeping.
export function mergeHighlightsWithReserve(highlights, { vod, bannedRanges = [], maxHighlights = detectorCfg.maxHighlightsPerVod } = {}) {
  const ranked = [...highlights].sort((a, b) => b.score - a.score);
  const accepted = [];
  for (const h of ranked) {
    if (!accepted.some((a) => collides(h, a))) accepted.push(h);
  }

  const vodBanned = bannedRanges.filter((b) => b.vodId === vod?.vodId);
  const notBanned = accepted.filter((h) =>
    !vodBanned.some((b) => h.startSec < b.endSec && h.endSec > b.startSec),
  );
  if (notBanned.length < accepted.length) {
    logger.info({ vodId: vod?.vodId, skipped: accepted.length - notBanned.length }, 'merge.bannedRangesFiltered');
  }

  return {
    accepted: notBanned.slice(0, maxHighlights).sort((a, b) => a.startSec - b.startSec),
    reserve: notBanned.slice(maxHighlights),
  };
}
