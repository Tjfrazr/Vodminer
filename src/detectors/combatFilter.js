import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { detector as detectorCfg } from '../../config.js';

const CF = detectorCfg.combatFilter;

// Why this exists: the signal detectors (audio RMS spikes, ffmpeg scene cuts)
// have zero idea what's on screen — a loud menu click and a sword clash produce
// the same amplitude spike (real false positive: God of War VOD, "Poor, I was
// just in the menu", rated 1/10). No threshold tune fixes a semantic problem,
// so for action/fighting games this filter samples a few frames from each
// merged candidate and asks a local vision model (via Ollama — no API key,
// nothing leaves the machine) whether the player is actively fighting,
// dropping the no's BEFORE the expensive preview render + Discord post.
//
// Prompt note: an early version asked for a COMBAT/SKIP verdict against a
// list of negative examples (menus, cutscenes, exploration, ...) and every
// model tested (moondream, llava:13b, gemma3:4b) answered COMBAT on
// literally everything, including an unambiguous weapons-menu screenshot —
// small vision models handle negation-heavy category lists badly. Asking
// the same models a single direct yes/no question ("is the player mid-fight
// right now") classified correctly on every manually-reviewed test frame.
// Keep the prompt simple; don't reintroduce a category list.
//
// Fail-open by design: a filter mistake must cost an extra Discord review, not
// a lost highlight. Any error (Ollama unreachable, ffmpeg failure, ambiguous
// reply) keeps the candidate.

// gameName-keyed genre gate. Case-insensitive substring match so "God of War",
// "God of War Ragnarök", "ELDEN RING NIGHTREIGN" etc. all hit without needing
// exact-title entries. Non-matching games (racing, strategy, visual novels)
// skip the filter entirely.
export function isActionGame(gameName, keywords = CF.actionGameKeywords) {
  if (!gameName) return false;
  const name = String(gameName).toLowerCase();
  return keywords.some((k) => name.includes(k));
}

// Model replies are instructed to be a single word, but parse defensively:
// only an unambiguous YES/NO drops or keeps; anything else (garbage, a reply
// containing both words, empty) returns null → caller keeps the clip.
export function parseVerdict(text) {
  const t = String(text ?? '').toUpperCase();
  const yes = /\bYES\b/.test(t);
  const no = /\bNO\b/.test(t);
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

const PROMPT =
  'Look at this video game screenshot. Is the player character currently mid-fight, ' +
  'actively attacking or being attacked by an enemy right now in this exact frame? ' +
  'Answer with just YES or NO.';

// Grab a single downscaled JPEG frame from the HLS stream at timeSec.
// Input-side -ss makes ffmpeg fetch only the segments around the seek point,
// so this is cheap even on a multi-hour VOD. Same spawn/timer/settled guard
// pattern as previewClip.compress and motionDetector.runSceneDetect.
function extractFrame(streamUrl, timeSec, outPath, { timeoutMs = CF.frameTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(timeSec),
      '-i', streamUrl,
      '-frames:v', '1',
      '-vf', `scale=${CF.frameWidth}:-2`,
      '-q:v', '4',
      outPath,
    ]);

    let ffErr = '';
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve(outPath);
    }

    const timer = setTimeout(
      () => finish(new Error(`frame extract timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    ff.stderr.on('data', (d) => { ffErr += d.toString(); });
    ff.on('error', finish);
    ff.on('close', (code) => {
      if ((code ?? 0) !== 0) return finish(new Error(`ffmpeg exit ${code}: ${ffErr.slice(-500)}`));
      finish();
    });
  });
}

// Evenly-spaced sample points strictly inside the window (avoids the pre/post
// roll padding at the edges, which is the least likely part to show the action).
export function frameTimes(startSec, endSec, count = CF.framesPerHighlight) {
  const dur = endSec - startSec;
  const times = [];
  for (let i = 1; i <= count; i += 1) {
    times.push(Math.round(startSec + (dur * i) / (count + 1)));
  }
  return times;
}

// One frame in, one verdict out. Classified independently per-frame (not as
// a batch) — that's the exact shape validated against real VOD frames.
async function classifyFrame(frameBase64, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CF.ollamaHost}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CF.model,
      prompt: PROMPT,
      images: [frameBase64],
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return parseVerdict(data.response);
}

// Default per-highlight classifier: resolve the VOD's HLS URL once (lazily, on
// first classified highlight), extract frames into a temp dir, ask the local
// model. A highlight counts as combat if ANY sampled frame says YES — a real
// fight only needs one frame to catch it, and this stays on the
// conservative/keep-it side of the fail-open design.
// Returns true (combat) / false (not combat) / null (couldn't tell — keep).
function createFrameClassifier(vod) {
  let streamUrlPromise = null;
  return async function classify(highlight) {
    streamUrlPromise ??= resolveStreamUrl(vod.url, CF.ytFormat);
    const streamUrl = await streamUrlPromise;
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-combat-'));
    try {
      const times = frameTimes(highlight.startSec, highlight.endSec);
      let sawYes = false;
      let sawAnyVerdict = false;
      for (const [i, t] of times.entries()) {
        const framePath = path.join(dir, `frame-${i}.jpg`);
        await extractFrame(streamUrl, t, framePath);
        const frameBase64 = (await readFile(framePath)).toString('base64');
        const verdict = await classifyFrame(frameBase64);
        if (verdict !== null) sawAnyVerdict = true;
        if (verdict === true) { sawYes = true; break; }
      }
      if (!sawAnyVerdict) return null;
      return sawYes;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * Filter merged highlights down to ones showing actual combat, for action
 * games only. Runs AFTER mergeHighlights (so at most maxHighlightsPerVod
 * classifications) and BEFORE preview render / Discord post.
 *
 * Pass-through (returns input unchanged) when: filter disabled, gameName
 * doesn't match an action-game keyword, or Ollama isn't reachable. Per-highlight
 * errors keep that highlight (fail open). Viewer clips are never filtered — a
 * human already decided they were worth clipping.
 *
 * `classify` is injectable for tests.
 */
export async function filterCombatHighlights(highlights, { vod, gameName, classify } = {}) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!CF.enabled) return highlights;
  if (!isActionGame(gameName)) {
    logger.debug({ vodId: vod?.vodId, gameName }, 'combatFilter.skipped.notActionGame');
    return highlights;
  }

  const classifyFn = classify ?? createFrameClassifier(vod);
  const kept = [];
  let checked = 0;
  let dropped = 0;

  for (const h of highlights) {
    if (h.reason === 'viewer_clip') {
      kept.push(h);
      continue;
    }
    checked += 1;
    let verdict = null;
    try {
      verdict = await classifyFn(h);
    } catch (err) {
      logger.warn(
        { err: err?.message, vodId: vod?.vodId, range: `${h.startSec}-${h.endSec}` },
        'combatFilter.classifyFailed',
      );
    }
    if (verdict === false) {
      dropped += 1;
      logger.info(
        { vodId: vod?.vodId, range: `${h.startSec}-${h.endSec}`, reason: h.reason, score: h.score },
        'combatFilter.dropped',
      );
    } else {
      kept.push(h);
    }
  }

  logger.info({ vodId: vod?.vodId, gameName, checked, dropped, kept: kept.length }, 'combatFilter.done');
  return kept;
}

export default { filterCombatHighlights, isActionGame };
