import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { extractFrame, frameTimes, parseVerdict } from './combatFilter.js';
import { detector as detectorCfg } from '../../config.js';

const RF = detectorCfg.racingFilter;

// Why this exists: the generic candidate detectors (audio transient, scene-cut)
// already find "something happened here" moments for any game, racing included.
// What they can't tell you is *what* happened — a crash, an overtake, and a
// drift all read as a motion/audio spike. This pass runs after mergeHighlights
// and, for racing games, samples frames from each candidate and asks a local
// vision model (Ollama, same as combatFilter.js — no API key, nothing leaves
// the machine) which racing category it looks like, so clip titles and Discord
// review messages say "OVERTAKE @ 4:32" instead of a generic timestamp.
//
// Unlike combatFilter, this is a LABELING pass, not a filtering one: it never
// drops a candidate, only adds a `category` field (null if nothing matched).
// Reason: the combat filter's prompts took three real iterations against real
// God of War frames before they stopped false-positiving on menus (see
// combatFilter.js header). These racing prompts have not been validated
// against any real Forza footage yet, so dropping highlights based on them
// would risk silently losing real content. Labeling is safe to ship blind;
// dropping is not. Revisit once there's real footage to tune against — same
// caveat already flagged on editing.silence in config.js for racing audio.
//
// Categories requiring on-screen text (fastest lap via the lap timer, exact
// top-speed thresholds via the speedometer) are deliberately NOT implemented
// here — that needs OCR (e.g. tesseract.js) against HUD regions whose pixel
// coordinates depend on the game's actual HUD layout, which nobody has looked
// at yet. Vision-classifiable categories only, for now.

export function isRacingGame(gameName, keywords = RF.racingGameKeywords) {
  if (!gameName) return false;
  const name = String(gameName).toLowerCase();
  return keywords.some((k) => name.includes(k));
}

// Checked in this order per sampled frame; first YES wins. Crash and jump
// first — they're the least ambiguous (rare for a model to false-positive
// "airborne" or "just hit a wall" on ordinary driving) and the most costly
// to mislabel as something vaguer like wheel-to-wheel.
const CATEGORY_PROMPTS = [
  {
    category: 'CRASH',
    prompt:
      'Look at this racing video game screenshot. Did the player\'s car just crash — ' +
      'hit a wall, guardrail, another car, or spin out of control? ' +
      'Answer with just YES or NO.',
  },
  {
    category: 'JUMP',
    prompt:
      'Look at this racing video game screenshot. Is the car airborne, ' +
      'off the ground mid-jump? Answer with just YES or NO.',
  },
  {
    category: 'DRIFT',
    prompt:
      'Look at this racing video game screenshot. Is the car drifting — sliding ' +
      'sideways through a turn with the rear end out, tires angled away from the ' +
      'direction of travel? Answer with just YES or NO.',
  },
  {
    category: 'WHEEL_TO_WHEEL',
    prompt:
      'Look at this racing video game screenshot. Are two cars racing directly ' +
      'side by side, close enough to touch? Answer with just YES or NO.',
  },
  {
    category: 'OVERTAKE',
    prompt:
      'Look at this racing video game screenshot. Is one car pulling alongside ' +
      'or passing another car for position? Answer with just YES or NO.',
  },
];

async function classifyFrame(frameBase64, prompt, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${RF.ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: RF.model, prompt, images: [frameBase64], stream: false }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseVerdict(data.response);
}

function createFrameCategorizer(vod) {
  let streamUrlPromise = null;
  return async function categorize(highlight) {
    streamUrlPromise ??= resolveStreamUrl(vod.url, RF.ytFormat);
    const streamUrl = await streamUrlPromise;
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-racing-'));
    try {
      const times = frameTimes(highlight.startSec, highlight.endSec, RF.framesPerHighlight);
      for (const [i, t] of times.entries()) {
        const framePath = path.join(dir, `frame-${i}.jpg`);
        await extractFrame(streamUrl, t, framePath);
        const frameBase64 = (await readFile(framePath)).toString('base64');
        for (const { category, prompt } of CATEGORY_PROMPTS) {
          const verdict = await classifyFrame(frameBase64, prompt);
          if (verdict === true) return category;
        }
      }
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export async function categorizeRacingHighlights(highlights, { vod, gameName, categorize } = {}) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!RF.enabled) return highlights;
  if (!isRacingGame(gameName)) {
    logger.debug({ gameName }, 'racingFilter.skipNonRacingGame');
    return highlights;
  }
  const categorizeFn = categorize ?? createFrameCategorizer(vod);
  const out = [];
  for (const h of highlights) {
    let category = null;
    try {
      category = await categorizeFn(h);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'racingFilter.categorizeFailed');
    }
    out.push(category ? { ...h, category } : h);
  }
  logger.info(
    { vodId: vod.vodId, total: out.length, categorized: out.filter((h) => h.category).length },
    'racingFilter.done',
  );
  return out;
}
