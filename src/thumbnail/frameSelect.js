import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.js';
import { parseSceneEvents, groupSceneEvents } from '../detectors/motionDetector.js';

// Picks a thumbnail frame from an already-local video file (no facecam, so
// no face-detection dependency needed — see docs/v2-phase2-youtube-architecture.md
// revision). True pixel-level sharpness/blur scoring needs a real image
// library (OpenCV, PIL); ffmpeg's CLI doesn't expose that directly without a
// custom filter graph. The pragmatic ffmpeg-only substitute: pick the
// frame at the highest-scoring scene-cut (reusing motionDetector's own
// scene-parsing, since it's already proven code, not reimplemented),
// excluding anything inside a detected black frame (loading screens, transitions).

const SCENE_THRESHOLD = 0.3;
const BLACK_MIN_DURATION_SEC = 0.5;
const FILTER_TIMEOUT_MS = 10 * 60 * 1000;

function runFilterPass(inputPath, filterArg) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'info',
      '-i', inputPath,
      '-vf', filterArg,
      '-an', '-f', 'null', '-',
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
    const timer = setTimeout(() => finish(new Error(`ffmpeg filter pass timed out after ${FILTER_TIMEOUT_MS}ms`)), FILTER_TIMEOUT_MS);
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', finish);
    ff.on('close', (code) => {
      if ((code ?? 0) !== 0) return finish(new Error(`ffmpeg exit ${code}`));
      finish();
    });
  });
}

export function parseBlackIntervals(stderrText) {
  return [...stderrText.matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)/g)].map((m) => ({
    start: Number(m[1]),
    end: Number(m[2]),
  }));
}

function isInBlack(timeSec, blackIntervals) {
  return blackIntervals.some((b) => timeSec >= b.start && timeSec <= b.end);
}

function extractFrame(inputPath, timeSec, outputJpgPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(timeSec),
      '-i', inputPath,
      '-vframes', '1', '-q:v', '2',
      outputJpgPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => ((code ?? 0) !== 0 ? reject(new Error(`ffmpeg frame extract exit ${code}: ${stderr.slice(-300)}`)) : resolve()));
  });
}

// Selects a thumbnail frame from inputPath and writes it to outputJpgPath.
// Falls back to the frame at 25% of the video's duration if no usable
// scene-cut candidate is found (matches the fallback shape already
// documented for other stages in this pipeline).
export async function pickThumbnailFrame(inputPath, outputJpgPath, { durationSec } = {}) {
  const [sceneText, blackText] = await Promise.all([
    runFilterPass(inputPath, `select=gt(scene\\,${SCENE_THRESHOLD}),metadata=print`),
    runFilterPass(inputPath, `blackdetect=d=${BLACK_MIN_DURATION_SEC}`),
  ]);

  const blackIntervals = parseBlackIntervals(blackText);
  const events = parseSceneEvents(sceneText);
  const groups = groupSceneEvents(events);
  const candidates = groups
    .filter((g) => !isInBlack(g.startSec, blackIntervals))
    .sort((a, b) => b.peakScore - a.peakScore);

  const chosenSec = candidates.length > 0
    ? candidates[0].startSec
    : Math.max(0, (durationSec ?? 60) * 0.25);

  await extractFrame(inputPath, chosenSec, outputJpgPath);
  logger.info(
    { inputPath, outputJpgPath, chosenSec, candidates: candidates.length, fallback: candidates.length === 0 },
    'frameSelect: thumbnail picked',
  );
  return { chosenSec, candidateCount: candidates.length, usedFallback: candidates.length === 0 };
}

export default { pickThumbnailFrame };
