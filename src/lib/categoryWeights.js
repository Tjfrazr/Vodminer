import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const MIN_SAMPLES = 3; // fewer than this and one bad rating would swing a whole category — treat as noise
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 1.5;
const GOOD_RATING_THRESHOLD = 8; // matches reviewBot.js's LOW_SCORE_THRESHOLD — same definition of "good"

// Turns rating history into a per-key score multiplier so mergeHighlights
// ranks types you consistently rate well above ones you consistently
// disapprove/rate low. Key is category when the clip went through
// combat/racing categorization, else the raw detector reason
// (audio_transient, motion, viewer_clip) — see the caller for why: category
// isn't known until after the maxHighlights cap, so weighting new
// (uncategorized) candidates can only ever key off reason. This still
// records category-level history for visibility even though it can't yet
// feed back into pre-cap selection — see pipeline.js callers.
//
// "good" = rated >= 8/10. "bad" = disapproved (explicit Disapprove click, or
// an auto-deleted low rating below 8 — see reviewBot.js's deleteAndReplenish).
export async function computeCategoryWeights() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }

  const tally = {}; // key -> { good, bad }
  for (const clip of manifest.clips ?? []) {
    const key = clip.category ?? clip.reason;
    if (!key) continue;
    const isGood = typeof clip.rating === 'number' && clip.rating >= GOOD_RATING_THRESHOLD;
    const isBad = clip.disapproved === true;
    if (!isGood && !isBad) continue;
    tally[key] ??= { good: 0, bad: 0 };
    if (isGood) tally[key].good += 1;
    if (isBad) tally[key].bad += 1;
  }

  const weights = {};
  for (const [key, { good, bad }] of Object.entries(tally)) {
    const total = good + bad;
    if (total < MIN_SAMPLES) continue;
    const ratio = (good - bad) / total; // -1 (all bad) .. 1 (all good)
    weights[key] = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, 1 + ratio * 0.5));
  }
  return weights;
}
