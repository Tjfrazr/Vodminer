import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { extractFrame, frameTimes, parseVerdict } from './combatFilter.js';
import { detector as detectorCfg } from '../../config.js';

const SF = detectorCfg.sportsFilter;

// Why this exists: same gap as racing/tacticalFilter — the generic candidate
// detectors (audio transient, scene-cut) find "something happened" moments but
// can't say *what*. In a sports game (EA Sports FC, Madden, NBA 2K, MLB The
// Show, NHL, ...) a goal-horn crowd eruption and a loud halftime-menu click
// read as the same audio spike. This pass runs after mergeHighlights and, for
// sports games, samples frames from each candidate and asks a local vision
// model (Ollama, same as combatFilter.js — no API key, nothing leaves the
// machine) which sports category it looks like, so review messages say
// "CELEBRATION @ 12:04" instead of a bare timestamp.
//
// Research basis: broadcast-soccer highlight research (SoccerNet-v2's replay
// grounding task; logo-transition replay detectors) converges on one insight:
// the production layer *around* a big play — the slow-motion instant replay,
// the celebration shots, the full-screen score graphic — is a far more
// reliable highlight signal than recognizing the play itself. Commercial game
// clippers exploit exactly this: Eklipse detects NBA 2K poster dunks via the
// slow-mo replay window + crowd audio surge, and FIFA-mode clippers key on
// crowd eruptions after goals. Sports games faithfully imitate broadcast
// presentation, so those aftermath signals are visually unambiguous,
// single-frame-classifiable concepts a small vision model can answer a direct
// yes/no question about — unlike the play types themselves.
//
// Like racing/tacticalFilter — and unlike combatFilter — this is a LABELING
// pass, not a filtering one: it never drops a candidate, only adds a
// `category` field (absent if nothing matched). Reason: these prompts have not
// been validated against any real FIFA/Madden/2K footage (combatFilter's
// prompt took three iterations against real God of War frames before it
// stopped false-positiving on menus). Dropping on unvalidated prompts risks
// silently losing real content; labeling is safe to ship blind. Revisit once
// there's real footage to tune against.
//
// Prompt shape note (hard-won, see combatFilter.js header): every prompt below
// is one simple, direct yes/no question about one concept. Category-list
// prompts made every tested local model (moondream, llava:13b, gemma3:4b)
// answer positive on everything, including unambiguous negative examples. Do
// not collapse these into a single pick-a-category prompt.
//
// Categories from the request that are deliberately NOT implemented here
// (same precedent as tacticalFilter deferring CLUTCH_SAVE and racingFilter
// deferring HIGH_SPEED/FASTEST_LAP):
//   - CONTEXT-AWARE WEIGHTING   — the request asked for identical plays to be
//     (game-winning plays,        weighted by score differential, remaining
//     comeback moments,           game time, difficulty, and match importance.
//     clutch plays,               All of that state lives in the on-screen
//     close-game boosts)          scoreboard/clock HUD as small text → needs
//                                 per-game OCR crop regions nobody has mapped,
//                                 PLUS cross-highlight game-state tracking
//                                 (score history over the whole match), which
//                                 is inherently temporal — a single frame
//                                 can't carry "this tied the game with 0:04
//                                 left". Deliberately NOT approximated with
//                                 indirect proxies (e.g. inferring "close
//                                 game" from crowd-noise volume) — that's an
//                                 unvalidated guess, exactly what this
//                                 codebase's convention avoids. Deferred until
//                                 HUD OCR + game-state tracking exist.
//   - OVERTIME_PERIOD /         — signalled by clock/period/stat HUD text or a
//     RECORD_BREAKING             brief stat banner → same unmapped-OCR
//                                 problem.
//   - GOAL vs TOUCHDOWN vs      — the specific play types. A sampled frame is
//     HOME_RUN vs SLAM_DUNK vs    far more likely to land in the 10-30s
//     GAME_WINNER                 aftermath presentation than the ~1s play
//                                 itself, and from an aftermath frame these
//                                 are visually identical. Folded into
//                                 SCORE_BANNER / CELEBRATION / REPLAY (the
//                                 same judgment as tacticalFilter folding
//                                 HOSTAGE_RESCUE into ARREST).
//   - ASSIST / STEAL /          — inherently temporal: a possession change or
//     INTERCEPTION / FAST_BREAK   a pass-before-the-score only exists across
//                                 frames; one frame of "player holding ball"
//                                 can't distinguish them.
// Vision-classifiable aftermath/presentation categories only, for now.

export function isSportsGame(gameName, keywords = SF.sportsGameKeywords) {
  if (!gameName) return false;
  const name = String(gameName).toLowerCase();
  return keywords.some((k) => name.includes(k));
}

// Checked in this order per sampled frame; first YES wins. Ordered
// most-visually-unambiguous first: a full-screen score graphic dominates the
// whole frame (hard to false-positive), trophy/confetti ceremonies are
// unmistakable, then the people-pose categories (celebration, penalty
// face-off, keeper dive), with the replay-camera check last as the softest
// signal (a cinematic angle can be confused with a cutscene).
const CATEGORY_PROMPTS = [
  {
    // Goals / touchdowns / home runs / dunks — the full-screen score
    // announcement graphic most sports games flash right after a score.
    // A dominant full-frame graphic, not small HUD text, so no OCR crop
    // region is needed — the model just looks at the whole frame.
    category: 'SCORE_BANNER',
    prompt:
      'Look at this video game screenshot. Is there a large celebratory graphic ' +
      'or text overlay filling much of the screen announcing a score, like GOAL ' +
      'or TOUCHDOWN or HOME RUN? ' +
      'Answer with just YES or NO.',
  },
  {
    // Match/championship wins — trophy lift, confetti, podium ceremony.
    category: 'VICTORY_CEREMONY',
    prompt:
      'Look at this video game screenshot. Is a team celebrating winning the ' +
      'match — lifting a trophy, confetti falling, or a victory ceremony? ' +
      'Answer with just YES or NO.',
  },
  {
    // The universal "a big play just happened" signal — and, until OCR and
    // game-state tracking exist, the stand-in for goals, touchdowns, home
    // runs, slam dunks, and game-winning plays (see the deferred-categories
    // note above).
    category: 'CELEBRATION',
    prompt:
      'Look at this video game screenshot. Are athletes celebrating right now — ' +
      'arms raised in triumph, jumping, hugging, or being mobbed by teammates? ' +
      'Answer with just YES or NO.',
  },
  {
    // Penalty kicks / shootout attempts — the one-on-one framing (single
    // shooter vs goalkeeper) is visually distinctive across soccer and hockey.
    category: 'PENALTY_SHOOTOUT',
    prompt:
      'Look at this video game screenshot. Is this a penalty kick or shootout ' +
      'attempt — a single player with the ball or puck facing only the ' +
      'goalkeeper? ' +
      'Answer with just YES or NO.',
  },
  {
    // Saves — a keeper mid-dive is a distinctive pose. Kept narrow ("diving or
    // leaping") so a keeper just standing in goal doesn't false-positive.
    category: 'SAVE',
    prompt:
      'Look at this video game screenshot. Is a goalkeeper or goalie diving or ' +
      'leaping to block a shot right now? ' +
      'Answer with just YES or NO.',
  },
  {
    // The slow-motion instant-replay window sports games show after big plays
    // — the signal broadcast-highlight research and commercial game clippers
    // both key on. Softest check (cinematic angles can look like cutscenes),
    // so it runs last.
    category: 'REPLAY',
    prompt:
      'Look at this video game screenshot. Is this an instant replay or a ' +
      'cinematic close-up shot of the action, rather than the normal ' +
      'zoomed-out gameplay camera? ' +
      'Answer with just YES or NO.',
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
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-sports-'));
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

export async function categorizeSportsHighlights(highlights, { vod, gameName, categorize } = {}) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!SF.enabled) return highlights;
  if (!isSportsGame(gameName)) {
    logger.debug({ gameName }, 'sportsFilter.skipNonSportsGame');
    return highlights;
  }
  const categorizeFn = categorize ?? createFrameCategorizer(vod);
  const out = [];
  for (const h of highlights) {
    let category = null;
    try {
      category = await categorizeFn(h);
    } catch (err) {
      logger.warn({ err: err?.message, vodId: vod.vodId, range: `${h.startSec}-${h.endSec}` }, 'sportsFilter.categorizeFailed');
    }
    out.push(category ? { ...h, category } : h);
  }
  logger.info(
    { vodId: vod.vodId, total: out.length, categorized: out.filter((h) => h.category).length },
    'sportsFilter.done',
  );
  return out;
}
