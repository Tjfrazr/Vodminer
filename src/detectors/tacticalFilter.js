import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { extractFrame, frameTimes, parseVerdict } from './combatFilter.js';
import { detector as detectorCfg } from '../../config.js';

const TF = detectorCfg.tacticalFilter;

// Why this exists: same gap as racingFilter — the generic candidate detectors
// (audio transient, scene-cut) find "something happened" moments but can't say
// *what*. In a tactical shooter (Ready or Not, Ground Branch, ...) a flashbang
// detonation, a door breach, and a loud menu click all read as the same audio
// spike. This pass runs after mergeHighlights and, for tactical-shooter games,
// samples frames from each candidate and asks a local vision model (Ollama,
// same as combatFilter.js — no API key, nothing leaves the machine) which
// tactical category it looks like, so review messages say "BREACH @ 12:04"
// instead of a bare timestamp.
//
// Research basis: published FPS highlight-detection systems (fine-tuned video
// models like X-CLIP on CS:GO/Valorant; YOLO+OCR pipelines reading kill feeds;
// telemetry parsers on demo files) all need either per-game HUD engineering,
// game data files, or trained models — none of which fit the strictly-free,
// local-only, genre-generic constraint here. What DOES transfer is their core
// insight: tactical-shooter highlights cluster around a handful of visually
// distinctive events (utility detonations, breaches, muzzle-flash exchanges,
// surrenders/arrests, coordinated entries), and those are exactly the concepts
// a small vision model can answer a direct yes/no question about from one frame.
//
// Like racingFilter — and unlike combatFilter — this is a LABELING pass, not a
// filtering one: it never drops a candidate, only adds a `category` field
// (absent/null if nothing matched). Reason: these prompts have not been
// validated against any real Ready or Not footage (combatFilter's prompt took
// three iterations against real God of War frames before it stopped
// false-positiving on menus). Dropping on unvalidated prompts risks silently
// losing real content; labeling is safe to ship blind. Revisit once there's
// real footage to tune against.
//
// Prompt shape note (hard-won, see combatFilter.js header): every prompt below
// is one simple, direct yes/no question about one concept. An early
// combat-filter prompt that asked the model to pick a category against a list
// of negative examples made every tested model (moondream, llava:13b,
// gemma3:4b) answer positive on literally everything, including a menu
// screenshot. Do not collapse these into a single pick-a-category prompt.
//
// Categories from the request that are deliberately NOT implemented here
// (same precedent as racingFilter deferring HIGH_SPEED/FASTEST_LAP):
//   - ACCURATE_SHOTS      — needs kill-feed / hit-confirm HUD OCR; nobody has
//                           mapped Ready or Not's HUD layout, so any crop
//                           region would be a blind guess.
//   - MISSION_COMPLETE    — end-of-mission banner is on-screen text → OCR,
//                           same blind-crop problem.
//   - HOSTAGE_RESCUE      — a rescued hostage and an arrested suspect are
//                           visually the same pose (kneeling/restrained
//                           person) in a single frame; telling them apart
//                           needs HUD objective text → OCR. Folded into
//                           ARREST until then.
//   - CLUTCH_SAVE /       — inherently temporal + state-dependent (last man
//     HIGH_RISK_ENGAGEMENT  standing, low health); a single frame can't carry
//                           that context, and health/squad state is HUD text
//                           → OCR again.
//   - MIRROR_USE          — the optiwand/mirror-gun viewport is too subtle
//                           for a 4B vision model to name reliably; skipped
//                           rather than shipped unvalidated.
// Vision-classifiable categories only, for now.

export function isTacticalShooterGame(gameName, keywords = TF.tacticalGameKeywords) {
  if (!gameName) return false;
  const name = String(gameName).toLowerCase();
  return keywords.some((k) => name.includes(k));
}

// Checked in this order per sampled frame; first YES wins. Ordered
// most-visually-unambiguous first: a flashbang whiteout or a breach explosion
// dominates the whole frame (hard to false-positive, and a whited-out frame
// would confuse every later question anyway), muzzle flash next, then the
// people-pose categories (arrest, stack), with the tint-based NVG check last
// as the softest signal.
const CATEGORY_PROMPTS = [
  {
    // Tactical equipment use (flashbangs) — the detonation whiteout frame.
    category: 'FLASHBANG',
    prompt:
      'Look at this video game screenshot. Is the screen mostly whited out or ' +
      'blindingly bright, like a flashbang or stun grenade just detonated? ' +
      'Answer with just YES or NO.',
  },
  {
    // Tactical equipment use (breaching charges) + the entry moment of a push.
    category: 'BREACH',
    prompt:
      'Look at this video game screenshot. Is a door or wall being blown open — ' +
      'an explosion, smoke, or flying debris at a doorway? ' +
      'Answer with just YES or NO.',
  },
  {
    // Intense firefights / high-risk engagements (the frame-visible part of them).
    category: 'FIREFIGHT',
    prompt:
      'Look at this video game screenshot. Is a gun being fired right now — ' +
      'muzzle flash visible, or someone actively shooting? ' +
      'Answer with just YES or NO.',
  },
  {
    // Suspect arrests + surrenders (and, until OCR exists, hostage rescues —
    // see the deferred-categories note above).
    category: 'ARREST',
    prompt:
      'Look at this video game screenshot. Is a person surrendering or being ' +
      'arrested — hands raised, kneeling on the ground, or being handcuffed? ' +
      'Answer with just YES or NO.',
  },
  {
    // Room clearing / coordinated team pushes — the stack-up before entry.
    category: 'TEAM_STACK',
    prompt:
      'Look at this video game screenshot. Are several teammates lined up close ' +
      'together against a wall or door, ready to enter a room? ' +
      'Answer with just YES or NO.',
  },
  {
    // Stealth approaches — night-vision is the frame-visible proxy (the
    // methodical dark-house creep is what NVG sections of these games are).
    category: 'NIGHT_VISION',
    prompt:
      'Look at this video game screenshot. Is the view through night vision ' +
      'goggles — the whole image tinted green or grainy monochrome? ' +
      'Answer with just YES or NO.',
  },
];

async function classifyFrame(frameBase64, prompt, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${TF.ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TF.model, prompt, images: [frameBase64], stream: false }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseVerdict(data.response);
}

function createFrameCategorizer(vod) {
  let streamUrlPromise = null;
  return async function categorize(highlight) {
    streamUrlPromise ??= resolveStreamUrl(vod.url, TF.ytFormat);
    const streamUrl = await streamUrlPromise;
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-tactical-'));
    try {
      const times = frameTimes(highlight.startSec, highlight.endSec, TF.framesPerHighlight);
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

export async function categorizeTacticalHighlights(highlights, { vod, gameName, categorize } = {}) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!TF.enabled) return highlights;
  if (!isTacticalShooterGame(gameName)) {
    logger.debug({ gameName }, 'tacticalFilter.skipNonTacticalGame');
    return highlights;
  }
  const categorizeFn = categorize ?? createFrameCategorizer(vod);
  const out = [];
  for (const h of highlights) {
    let category = null;
    try {
      category = await categorizeFn(h);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'tacticalFilter.categorizeFailed');
    }
    out.push(category ? { ...h, category } : h);
  }
  logger.info(
    { vodId: vod.vodId, total: out.length, categorized: out.filter((h) => h.category).length },
    'tacticalFilter.done',
  );
  return out;
}
