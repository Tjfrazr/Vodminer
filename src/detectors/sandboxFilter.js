import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { extractFrame, frameTimes, parseVerdict } from './combatFilter.js';
import { detector as detectorCfg } from '../../config.js';

const SF = detectorCfg.sandboxFilter;

// Why this exists: same gap as racingFilter/tacticalFilter — the generic
// candidate detectors (audio transient, scene-cut) find "something happened"
// moments but can't say *what*. In an open-world sandbox game (GTA V,
// Red Dead Redemption 2, ...) an explosion, a five-car pileup, and a loud
// radio-station ad all read as the same audio spike. This pass runs after
// mergeHighlights and, for sandbox games, samples frames from each candidate
// and asks a local vision model (Ollama, same as combatFilter.js — no API key,
// nothing leaves the machine) which sandbox category it looks like, so review
// messages say "POLICE_CHASE @ 42:10" instead of a bare timestamp.
//
// Research basis: GTA-specific clip tools (FragCut, GTAClipper, Eklipse,
// Clypse) all advertise the same moment vocabulary — police chases /
// wanted-level escapes, heist finales, stunt jumps, vehicle fails/crashes,
// free-mode chaos & explosions, ragdoll/NPC comedy. Two transferable
// takeaways: (1) the visually detectable subset of that vocabulary is
// pyrotechnics, airborne/wrecked vehicles, flashing police lights, muzzle
// flash, and flying/sprawled bodies — all things a small vision model can
// answer a direct yes/no question about from one frame; (2) the "funny"
// moments are detected by those tools via *audio* (streamer laughter, voice
// intensity, chat reactions), not vision — which is why FUNNY_NPC is deferred
// below rather than shipped as a hopeless "is this frame funny?" prompt.
//
// Unlike the other genre filters, the gameplay here is emergent — there is no
// fixed loop (race lap, room clear) to anchor prompts to. That makes the
// category list wider, but the mechanism is deliberately identical: this is a
// LABELING pass, not a filtering one. It never drops a candidate, only adds a
// `category` field (absent/null if nothing matched). Reason: these prompts
// have not been validated against any real GTA footage (combatFilter's prompt
// took three iterations against real God of War frames before it stopped
// false-positiving on menus). Dropping on unvalidated prompts risks silently
// losing real content; labeling is safe to ship blind. Revisit once there's
// real footage to tune against.
//
// Prompt shape note (hard-won, see combatFilter.js header): every prompt below
// is one simple, direct yes/no question about one concept. An early
// combat-filter prompt that asked the model to pick a category against a list
// of negative examples made every tested model (moondream, llava:13b,
// gemma3:4b) answer positive on literally everything, including a menu
// screenshot. GTA's wide category list makes a single pick-a-category prompt
// extra tempting — do not do it.
//
// Categories from the request that are deliberately NOT implemented here
// (same precedent as racingFilter deferring HIGH_SPEED/FASTEST_LAP and
// tacticalFilter deferring MISSION_COMPLETE/CLUTCH_SAVE):
//   - MISSION_COMPLETE     — "Mission Passed" is an on-screen banner → OCR;
//                            nobody has mapped GTA's banner region, so any
//                            crop would be a blind guess.
//   - WANTED_LEVEL /       — the stars are tiny HUD icons (top of screen) →
//     HIGH_SPEED_ESCAPE      HUD-region OCR, and "escape" is temporal (stars
//                            flashing then gone). The chase itself is visual
//                            and covered by POLICE_CHASE.
//   - HEIST                — a whole multi-stage activity (setup, approach,
//                            escape), not a single visual moment; its
//                            frame-visible peaks (vault explosion, cop
//                            shootout, getaway chase) are already covered by
//                            EXPLOSION / SHOOTOUT / POLICE_CHASE.
//   - CLOSE_CALL           — inherently temporal: a near-miss is defined by
//                            the frame where impact *doesn't* happen, which
//                            is indistinguishable from ordinary driving in a
//                            single frame.
//   - MULTIPLAYER_ENCOUNTER — needs lobby/player-count game state; another
//                            player is visually identical to an NPC in a
//                            frame.
//   - FUNNY_NPC            — "funny" is not a visual predicate a 4B model can
//                            answer; the tools that detect it (Clypse) use
//                            streamer laughter / voice / chat audio, not
//                            frames. The slapstick physics part IS visual and
//                            is covered by RAGDOLL.
// Vision-classifiable categories only, for now.

export function isSandboxGame(gameName, keywords = SF.sandboxGameKeywords) {
  if (!gameName) return false;
  const name = String(gameName).toLowerCase();
  return keywords.some((k) => name.includes(k));
}

// Checked in this order per sampled frame; first YES wins. Ordered
// most-visually-unambiguous first: a fireball dominates the whole frame (and
// would confuse every later question anyway), then unmistakable object states
// (a car in mid-air, police light bars, a wrecked/flipped vehicle), then the
// finer signals (muzzle flash, a flying/sprawled body), with the pose-subtle
// carjacking check last.
const CATEGORY_PROMPTS = [
  {
    // Explosions + the frame-visible peak of heist finales / free-mode chaos.
    category: 'EXPLOSION',
    prompt:
      'Look at this video game screenshot. Is there an explosion happening — ' +
      'a fireball, a large burst of flame, or a vehicle blowing up? ' +
      'Answer with just YES or NO.',
  },
  {
    // Stunt jumps + aerial vehicle stunts ("unexpected physics" when it's a car).
    category: 'STUNT_JUMP',
    prompt:
      'Look at this video game screenshot. Is a car, motorcycle, or other ' +
      'vehicle flying through the air, off the ground mid-jump? ' +
      'Answer with just YES or NO.',
  },
  {
    // Police chases (and the visual part of wanted-level escapes — see the
    // deferred-categories note above).
    category: 'POLICE_CHASE',
    prompt:
      'Look at this video game screenshot. Are police visible with flashing ' +
      'red and blue lights — police cars, or a police helicopter with a ' +
      'searchlight? Answer with just YES or NO.',
  },
  {
    // Dramatic crashes / vehicle fails.
    category: 'VEHICLE_CRASH',
    prompt:
      'Look at this video game screenshot. Is a vehicle crashing or wrecked — ' +
      'smashed into something, flipped over, or badly damaged with debris? ' +
      'Answer with just YES or NO.',
  },
  {
    // Shootouts (and the gunfight stage of heists).
    category: 'SHOOTOUT',
    prompt:
      'Look at this video game screenshot. Is a gun being fired right now — ' +
      'muzzle flash visible, or someone actively shooting? ' +
      'Answer with just YES or NO.',
  },
  {
    // Unexpected physics moments + the visual half of funny NPC interactions
    // (Euphoria-engine ragdolls are the signature GTA comedy clip).
    category: 'RAGDOLL',
    prompt:
      'Look at this video game screenshot. Is a person being flung through ' +
      'the air or sprawled limply on the ground, like a ragdoll after being ' +
      'hit? Answer with just YES or NO.',
  },
  {
    // Vehicle thefts — the yank-the-driver-out carjacking animation is the
    // one frame-visible part of "stealing a car" (a person simply getting
    // into a car is not distinguishable from normal play).
    category: 'CARJACKING',
    prompt:
      'Look at this video game screenshot. Is one person pulling or throwing ' +
      'another person out of a car? Answer with just YES or NO.',
  },
];

async function classifyFrame(frameBase64, prompt, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${SF.ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SF.model, prompt, images: [frameBase64], stream: false }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseVerdict(data.response);
}

function createFrameCategorizer(vod) {
  let streamUrlPromise = null;
  return async function categorize(highlight) {
    streamUrlPromise ??= resolveStreamUrl(vod.url, SF.ytFormat);
    const streamUrl = await streamUrlPromise;
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-sandbox-'));
    try {
      const times = frameTimes(highlight.startSec, highlight.endSec, SF.framesPerHighlight);
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

export async function categorizeSandboxHighlights(highlights, { vod, gameName, categorize } = {}) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!SF.enabled) return highlights;
  if (!isSandboxGame(gameName)) {
    logger.debug({ gameName }, 'sandboxFilter.skipNonSandboxGame');
    return highlights;
  }
  const categorizeFn = categorize ?? createFrameCategorizer(vod);
  const out = [];
  for (const h of highlights) {
    let category = null;
    try {
      category = await categorizeFn(h);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'sandboxFilter.categorizeFailed');
    }
    out.push(category ? { ...h, category } : h);
  }
  logger.info(
    { vodId: vod.vodId, total: out.length, categorized: out.filter((h) => h.category).length },
    'sandboxFilter.done',
  );
  return out;
}
