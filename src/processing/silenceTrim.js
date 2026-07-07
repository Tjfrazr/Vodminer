import { spawn } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../lib/logger.js';

// Cuts dead air (silence) from a video. This project has no mic/commentary
// track, so the usual "cut where nobody's talking" tool (auto-editor, a
// Python CLI) doesn't fit — and this machine has no Python/pip installed at
// all, so pulling in a whole new language runtime for one feature is a
// heavier rung than necessary. ffmpeg already ships a `silencedetect` filter
// that does the same detection job (silence = low volume for N seconds,
// works on any audio track including game sound, not just voice) with zero
// new dependencies — this reimplements the same "keep the non-silent parts"
// idea directly in ffmpeg.

const SILENCE_NOISE_DB = '-30dB';
const SILENCE_MIN_DURATION_SEC = 1.0;
const KEEP_PAD_SEC = 0.3; // don't cut flush against the silence boundary — leaves a little breathing room
const DETECT_TIMEOUT_MS = 30 * 60 * 1000; // batch job, not real-time — generous ceiling, not a real expectation
// Scales with input duration (floor 10 min) rather than a flat constant —
// this is a safety net on top of the stream-copy approach below, which
// should already be fast regardless of length, but was never verified
// against a multi-hour file, so the ceiling shouldn't assume that.
const SEGMENT_TIMEOUT_MS_PER_SEC = 2000; // 2s of budget per 1s of source duration
const SEGMENT_TIMEOUT_FLOOR_MS = 10 * 60 * 1000;

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const duration = Number(data?.format?.duration);
      if (!Number.isFinite(duration)) return reject(new Error('ffprobe: could not read duration'));
      resolve(duration);
    });
  });
}

function detectSilence(inputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'info',
      '-i', inputPath,
      '-af', `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_DURATION_SEC}`,
      '-f', 'null', '-',
    ]);
    let stderr = '';
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve(stderr);
    }
    const timer = setTimeout(
      () => finish(new Error(`silence detect timed out after ${DETECT_TIMEOUT_MS}ms`)),
      DETECT_TIMEOUT_MS,
    );
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', finish);
    ff.on('close', (code) => {
      if ((code ?? 0) !== 0) return finish(new Error(`ffmpeg silencedetect exit ${code}`));
      finish();
    });
  });
}

export function parseSilenceIntervals(stderrText) {
  const starts = [...stderrText.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderrText.matchAll(/silence_end:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const intervals = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    intervals.push({ start: starts[i], end: ends[i] });
  }
  return intervals;
}

// Inverts silence intervals within [0, totalDuration] into the ranges to KEEP.
export function buildKeepRanges(silences, totalDuration, { padSec = KEEP_PAD_SEC } = {}) {
  const keep = [];
  let cursor = 0;
  for (const s of silences) {
    const silStart = Math.max(0, s.start + padSec);
    const silEnd = Math.min(totalDuration, s.end - padSec);
    if (silStart > cursor) keep.push({ start: cursor, end: silStart });
    cursor = Math.max(cursor, silEnd);
  }
  if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
  return keep.filter((r) => r.end - r.start > 0.1);
}

// Extracts+concatenates the keep ranges via stream copy (no re-encode)
// instead of a single ffmpeg pass with one `select='between(...)'` clause
// per kept range. Two reasons: (1) a re-encode of a multi-hour file at
// preset medium is routinely a multi-hour CPU job in its own right — a
// bounded timeout can't both be "safe" and "sufficient" for that; (2) a VOD
// with dozens/hundreds of silence intervals turns the single select
// expression into a filter string evaluated per frame, an unbounded and
// untested cost. Stream-copy segment extraction is near-instant regardless
// of file length, and each segment's ffmpeg invocation is trivial to bound.
// Trade-off: `-ss` before `-i` with `-c copy` snaps to the nearest keyframe,
// so cut points can drift by a fraction of a second — acceptable given
// KEEP_PAD_SEC already leaves breathing room and this is dead-air removal,
// not frame-accurate editing.
function segmentTimeoutMs(durationSec) {
  return Math.max(SEGMENT_TIMEOUT_FLOOR_MS, durationSec * SEGMENT_TIMEOUT_MS_PER_SEC);
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve();
    }
    const timer = setTimeout(() => finish(new Error(`ffmpeg timed out after ${timeoutMs}ms`)), timeoutMs);
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', finish);
    ff.on('close', (code) => {
      if ((code ?? 0) !== 0) return finish(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
      finish();
    });
  });
}

async function extractSegment(inputPath, start, end, outPath) {
  await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', start.toFixed(3), '-to', end.toFixed(3),
      '-i', inputPath,
      '-c', 'copy', '-avoid_negative_ts', 'make_zero',
      outPath,
    ],
    segmentTimeoutMs(end - start),
  );
}

async function concatSegments(listPath, outputPath, totalDurationSec) {
  await runFfmpeg(
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath],
    segmentTimeoutMs(totalDurationSec),
  );
}

async function renderTrimmed(inputPath, outputPath, keepRanges) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-silencetrim-'));
  const segPaths = keepRanges.map((_, i) => path.join(dir, `seg-${i}.mp4`));
  try {
    for (let i = 0; i < keepRanges.length; i += 1) {
      await extractSegment(inputPath, keepRanges[i].start, keepRanges[i].end, segPaths[i]);
    }
    const listPath = path.join(dir, 'concat-list.txt');
    const listContent = segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, listContent, 'utf8');
    const totalDurationSec = keepRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    await concatSegments(listPath, outputPath, totalDurationSec);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Maps a timestamp on the ORIGINAL (pre-trim) timeline to where it now falls
// on the trimmed output's timeline. Returns null if the timestamp fell
// inside a cut (silence) range — there's no equivalent point in the output.
// Needed because trimSilence re-times everything via setpts/asetpts: any
// caller that computed timestamps against the original file (e.g. highlight
// detection for chapter markers) must translate them through this before
// applying them to the trimmed output, or every marker after the first cut
// silently points at the wrong moment.
export function mapToTrimmedTime(originalSec, keepRanges) {
  let cumulative = 0;
  for (const r of keepRanges) {
    if (originalSec < r.start) return null; // falls inside the cut gap before this range
    if (originalSec <= r.end) return cumulative + (originalSec - r.start);
    cumulative += r.end - r.start;
  }
  return null; // past the last kept range
}

// Cuts detected dead-air out of inputPath, writes the trimmed result to
// outputPath. Returns stats about what was cut, plus the keepRanges used
// (see mapToTrimmedTime) so callers can re-time any original-timeline
// timestamps against the output. If no silence is found (or everything
// would be cut, which should never legitimately happen), falls back to a
// straight copy so the caller always gets a usable output file — keepRanges
// in that case is the identity range [0, totalDuration].
export async function trimSilence(inputPath, outputPath) {
  const totalDuration = await probeDuration(inputPath);
  const stderrText = await detectSilence(inputPath);
  const silences = parseSilenceIntervals(stderrText);
  const keepRanges = buildKeepRanges(silences, totalDuration);

  if (keepRanges.length === 0 || silences.length === 0) {
    logger.info({ inputPath, silences: silences.length }, 'silenceTrim: nothing to cut, copying through');
    await copyThrough(inputPath, outputPath);
    return {
      originalDurationSec: totalDuration,
      keptDurationSec: totalDuration,
      keepRanges: [{ start: 0, end: totalDuration }],
      silenceIntervals: silences.length,
      trimmed: false,
    };
  }

  await renderTrimmed(inputPath, outputPath, keepRanges);
  const keptDurationSec = keepRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
  logger.info(
    { inputPath, outputPath, originalDurationSec: totalDuration, keptDurationSec, silenceIntervals: silences.length },
    'silenceTrim: done',
  );
  return {
    originalDurationSec: totalDuration,
    keptDurationSec,
    keepRanges,
    silenceIntervals: silences.length,
    trimmed: true,
  };
}

function copyThrough(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-c', 'copy', outputPath]);
    ff.on('error', reject);
    ff.on('close', (code) => ((code ?? 0) !== 0 ? reject(new Error(`ffmpeg copy exit ${code}`)) : resolve()));
  });
}

export default { trimSilence };
