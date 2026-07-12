import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { resolveStreamUrl } from '../lib/streamUrl.js';
import { detector as detectorCfg } from '../../config.js';

const CF = detectorCfg.combatFilter;

// Why this exists: the signal detectors (audio RMS spikes, ffmpeg scene cuts)
// have zero idea what's on screen — a loud menu click and a sword clash produce
// the same amplitude spike (real false positive: God of War VOD, "Poor, I was
// just in the menu", rated 1/10). No threshold tune fixes a semantic problem,
// so for action/fighting games this filter samples a few frames from each
// merged candidate and asks a multimodal Claude model "active combat or not?",
// dropping the not's BEFORE the expensive preview render + Discord post.
//
// Fail-open by design: a filter mistake must cost an extra Discord review, not
// a lost highlight. Any error (no API key, yt-dlp/ffmpeg failure, API error,
// ambiguous reply) keeps the candidate.

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
// only an unambiguous SKIP drops a clip; anything else (including garbage or a
// reply containing both words) returns null → caller keeps the clip.
export function parseVerdict(text) {
  const t = String(text ?? '').toUpperCase();
  const combat = /\bCOMBAT\b/.test(t);
  const skip = /\bSKIP\b/.test(t);
  if (combat && !skip) return true;
  if (skip && !combat) return false;
  return null;
}

const SYSTEM_PROMPT =
  'You classify video-game footage for an automated Twitch highlight-clipping pipeline. ' +
  'You are shown a few frames sampled from ONE candidate clip of a gameplay VOD. ' +
  'Decide whether the frames show active combat/fighting gameplay: the player attacking or being attacked, ' +
  'enemies engaged, boss fights, action set-pieces mid-fight. ' +
  'Everything else is NOT combat: menus, inventory or skill-tree screens, map screens, loading screens, ' +
  'shops, crafting, dialogue or cutscenes, idle exploration or walking with no enemies engaged. ' +
  'Reply with exactly one word: COMBAT if at least one frame clearly shows active combat gameplay, otherwise SKIP.';

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

let anthropicClient = null;
async function getClient() {
  if (!anthropicClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

async function classifyFrames(framesBase64, { gameName, highlight }) {
  const client = await getClient();
  const content = framesBase64.map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data },
  }));
  content.push({
    type: 'text',
    text:
      `Game: ${gameName}. These ${framesBase64.length} frames were sampled across one ` +
      `${highlight.endSec - highlight.startSec}s candidate highlight. COMBAT or SKIP?`,
  });
  const res = await client.messages.create({
    model: CF.model,
    max_tokens: CF.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  return parseVerdict(text);
}

// Default per-highlight classifier: resolve the VOD's HLS URL once (lazily, on
// first classified highlight), extract frames into a temp dir, ask Claude.
// Returns true (combat) / false (not combat) / null (couldn't tell — keep).
function createFrameClassifier(vod, gameName) {
  let streamUrlPromise = null;
  return async function classify(highlight) {
    streamUrlPromise ??= resolveStreamUrl(vod.url, CF.ytFormat);
    const streamUrl = await streamUrlPromise;
    const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-combat-'));
    try {
      const times = frameTimes(highlight.startSec, highlight.endSec);
      const frames = [];
      for (const [i, t] of times.entries()) {
        const framePath = path.join(dir, `frame-${i}.jpg`);
        await extractFrame(streamUrl, t, framePath);
        frames.push((await readFile(framePath)).toString('base64'));
      }
      return await classifyFrames(frames, { gameName, highlight });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * Filter merged highlights down to ones showing actual combat, for action
 * games only. Runs AFTER mergeHighlights (so at most maxHighlightsPerVod
 * classifications, ~20 API calls worst case) and BEFORE preview render /
 * Discord post.
 *
 * Pass-through (returns input unchanged) when: filter disabled, gameName
 * doesn't match an action-game keyword, no ANTHROPIC_API_KEY, or the stream
 * URL can't be resolved. Per-highlight errors keep that highlight (fail open).
 * Viewer clips are never filtered — a human already decided they were worth
 * clipping.
 *
 * `classify` and `apiKey` are injectable for tests.
 */
export async function filterCombatHighlights(
  highlights,
  { vod, gameName, classify, apiKey = env.ANTHROPIC_API_KEY } = {},
) {
  if (!Array.isArray(highlights) || highlights.length === 0) return highlights ?? [];
  if (!CF.enabled) return highlights;
  if (!isActionGame(gameName)) {
    logger.debug({ vodId: vod?.vodId, gameName }, 'combatFilter.skipped.notActionGame');
    return highlights;
  }
  if (!apiKey) {
    logger.warn({ vodId: vod?.vodId, gameName }, 'combatFilter.skipped.noApiKey');
    return highlights;
  }

  const classifyFn = classify ?? createFrameClassifier(vod, gameName);
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
