import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { detector as detectorCfg, video as videoCfg } from '../../config.js';

const M = detectorCfg.motion;

// Parse ffmpeg `metadata=print` output into scene-change events. Lines look like:
//   frame:0    pts:12    pts_time:6
//   lavfi.scene_score=0.400000
export function parseSceneEvents(text) {
  const events = [];
  let pending = null;
  for (const line of text.split('\n')) {
    const t = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (t) { pending = Number(t[1]); continue; }
    const s = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (s && pending !== null) {
      events.push({ timeSec: pending, score: Number(s[1]) });
      pending = null;
    }
  }
  return events;
}

// Cluster events closer than groupGapSec into groups, keeping the peak score.
export function groupSceneEvents(events, groupGapSec = M.groupGapSec) {
  const groups = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.timeSec - cur.endSec > groupGapSec) {
      cur = { startSec: e.timeSec, endSec: e.timeSec, peakScore: e.score };
      groups.push(cur);
    } else {
      cur.endSec = e.timeSec;
      if (e.score > cur.peakScore) cur.peakScore = e.score;
    }
  }
  return groups;
}

export function buildMotionHighlight(group, vod) {
  const midSec = (group.startSec + group.endSec) / 2;
  const naturalLen = (group.endSec - group.startSec) + detectorCfg.preRollSec + detectorCfg.postRollSec;
  const cappedMax = Math.min(detectorCfg.maxClipLengthSec, videoCfg.maxDurationSec);
  const clipLen = Math.max(detectorCfg.minClipLengthSec, Math.min(cappedMax, naturalLen));
  let startSec = Math.max(0, Math.round(midSec - clipLen / 2));
  let endSec = startSec + clipLen;
  if (vod.durationSec && endSec > vod.durationSec) {
    endSec = vod.durationSec;
    startSec = Math.max(0, endSec - clipLen);
  }
  return {
    vodId: vod.vodId,
    startSec,
    endSec,
    score: Number((group.peakScore * M.scoreScale).toFixed(2)),
    reason: 'motion',
    sceneScore: Number(group.peakScore.toFixed(3)),
  };
}

// Stream the lowest-res video through ffmpeg scene detection. Comma inside
// gt(scene,N) MUST be backslash-escaped when passed via spawn (no shell) or
// ffmpeg splits the filtergraph on it. Verified empirically.
const STDERR_CAP = 10000; // keep only the last chunk of stderr; yt-dlp spews progress

function runSceneDetect(vodUrl, metaPath) {
  return new Promise((resolve, reject) => {
    const yt = spawn('yt-dlp', ['-f', M.ytFormat, '--no-warnings', '-o', '-', vodUrl]);
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-an',
      '-vf', `fps=${M.fps},scale=${M.scaleWidth}:-1,select=gt(scene\\,${M.sceneThreshold}),metadata=print:file=${metaPath}`,
      '-f', 'null', '-',
    ]);

    yt.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {});

    let ytErr = '';
    let ffErr = '';
    let ytExit = null;
    let ffExit = null;
    let settled = false;

    // Guaranteed single-settle: kill BOTH children (a live/stalled yt-dlp never
    // EOFs, and a dead ffmpeg won't reliably take yt-dlp down via EPIPE), clear
    // the timeout, then resolve/reject exactly once.
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      yt.kill('SIGKILL');
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve();
    }

    // Wall-clock ceiling — without it, a network stall or an in-progress (still
    // live) VOD hangs runDetectors and the whole pipeline forever (DA H1).
    const timer = setTimeout(
      () => finish(new Error(`motion scene detect timed out after ${M.timeoutMs}ms`)),
      M.timeoutMs,
    );

    yt.stderr.on('data', (d) => { if (ytErr.length < STDERR_CAP) ytErr += d.toString(); });
    ff.stderr.on('data', (d) => { if (ffErr.length < STDERR_CAP) ffErr += d.toString(); });

    function settle() {
      if (ytExit === null || ffExit === null) return;
      if (ffExit !== 0) return finish(new Error(`ffmpeg exit ${ffExit}: ${ffErr.slice(-500)}`));
      if (ytExit !== 0) return finish(new Error(`yt-dlp exit ${ytExit}: ${ytErr.slice(-500)}`));
      finish();
    }

    yt.on('error', finish);
    ff.on('error', finish);
    yt.on('close', (c) => { ytExit = c ?? 0; settle(); });
    ff.on('close', (c) => { ffExit = c ?? 0; settle(); });
  });
}

async function detect(vod) {
  if (!vod?.url) {
    logger.warn({ vod }, 'motionDetector.noVodUrl');
    return [];
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-motion-'));
  const metaPath = path.join(dir, 'scene.txt');
  try {
    await runSceneDetect(vod.url, metaPath);
    const text = await readFile(metaPath, 'utf8').catch(() => '');
    const events = parseSceneEvents(text);
    const groups = groupSceneEvents(events);
    const highlights = groups
      .map((g) => buildMotionHighlight(g, vod))
      .sort((a, b) => b.score - a.score)
      .slice(0, detectorCfg.maxHighlightsPerVod);
    logger.info(
      { vodId: vod.vodId, sceneEvents: events.length, groups: groups.length, highlights: highlights.length },
      'motionDetector.done',
    );
    return highlights;
  } finally {
    // Let scan failures/timeouts propagate to runDetectors (the single catch
    // point) so they surface via detectorsFailed → Discord, not silently as [].
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export default { name: 'motion', detect };
