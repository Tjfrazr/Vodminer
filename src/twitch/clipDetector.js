import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.js';
import { detector as cfg, video as videoCfg } from '../../config.js';

const BYTES_PER_SAMPLE = 2;

export default async function detectClips(vod) {
  if (!vod?.url) {
    logger.warn({ vod }, 'detector.noVodUrl');
    return [];
  }

  const windows = await extractRmsWindows(vod.url);
  if (windows.length === 0) {
    logger.warn({ vodId: vod.vodId }, 'detector.noAudio');
    return [];
  }

  const stats = computeStats(windows);
  const threshold = stats.mean + cfg.spikeStddevs * stats.stddev;
  const spikes = [];
  for (let i = 0; i < windows.length; i++) {
    if (windows[i] > threshold) spikes.push({ idx: i, rms: windows[i] });
  }

  const groups = groupAdjacentSpikes(spikes, cfg.groupGapWindows);
  const highlights = groups
    .map((g) => buildHighlight(g, vod, stats))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.maxHighlightsPerVod);

  logger.info(
    { vodId: vod.vodId, audioWindows: windows.length, spikes: spikes.length, groups: groups.length, highlights: highlights.length },
    'detector.done',
  );
  return highlights;
}

function extractRmsWindows(vodUrl) {
  return new Promise((resolve, reject) => {
    const samplesPerWindow = cfg.audioSampleRate * cfg.windowSec;
    const bytesPerWindow = samplesPerWindow * BYTES_PER_SAMPLE;

    const yt = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '--no-warnings',
      '-o', '-',
      vodUrl,
    ]);
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-ac', '1',
      '-ar', String(cfg.audioSampleRate),
      '-f', 's16le',
      '-',
    ]);

    yt.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {});

    const windows = [];
    let buf = Buffer.alloc(0);
    let ytStderr = '';
    let ffStderr = '';
    let ytExit = null;
    let ffExit = null;

    yt.stderr.on('data', (d) => { ytStderr += d.toString(); });
    ff.stderr.on('data', (d) => { ffStderr += d.toString(); });

    ff.stdout.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length >= bytesPerWindow) {
        windows.push(rmsS16LE(buf.subarray(0, bytesPerWindow)));
        buf = buf.subarray(bytesPerWindow);
      }
    });

    function settle() {
      if (ytExit === null || ffExit === null) return;
      if (ffExit !== 0) {
        return reject(new Error(`ffmpeg exit ${ffExit}: ${ffStderr.slice(-500)}`));
      }
      if (ytExit !== 0) {
        return reject(new Error(`yt-dlp exit ${ytExit}: ${ytStderr.slice(-500)}`));
      }
      resolve(windows);
    }

    yt.on('error', reject);
    ff.on('error', reject);
    yt.on('close', (code) => { ytExit = code ?? 0; settle(); });
    ff.on('close', (code) => { ffExit = code ?? 0; settle(); });
  });
}

function rmsS16LE(buffer) {
  let sumSq = 0;
  const n = buffer.length / BYTES_PER_SAMPLE;
  for (let i = 0; i < buffer.length; i += BYTES_PER_SAMPLE) {
    const s = buffer.readInt16LE(i);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

function computeStats(values) {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    varSum += d * d;
  }
  return { mean, stddev: Math.sqrt(varSum / n) };
}

function groupAdjacentSpikes(spikes, maxGapWindows) {
  const groups = [];
  let cur = null;
  for (const s of spikes) {
    if (!cur || s.idx - cur.endIdx > maxGapWindows) {
      cur = { startIdx: s.idx, endIdx: s.idx, rmsMax: s.rms };
      groups.push(cur);
    } else {
      cur.endIdx = s.idx;
      if (s.rms > cur.rmsMax) cur.rmsMax = s.rms;
    }
  }
  return groups;
}

function buildHighlight(group, vod, stats) {
  const spikeStartSec = group.startIdx * cfg.windowSec;
  const spikeEndSec = (group.endIdx + 1) * cfg.windowSec;
  const spikeMidSec = (spikeStartSec + spikeEndSec) / 2;

  const naturalLen = (spikeEndSec - spikeStartSec) + cfg.preRollSec + cfg.postRollSec;
  const cappedMax = Math.min(cfg.maxClipLengthSec, videoCfg.maxDurationSec);
  const clipLen = Math.max(cfg.minClipLengthSec, Math.min(cappedMax, naturalLen));

  let startSec = Math.max(0, spikeStartSec - cfg.preRollSec);
  let endSec = startSec + clipLen;

  if (vod.durationSec && endSec > vod.durationSec) {
    endSec = vod.durationSec;
    startSec = Math.max(0, endSec - clipLen);
  }

  const score = stats.stddev > 0
    ? (group.rmsMax - stats.mean) / stats.stddev
    : 0;

  return {
    vodId: vod.vodId,
    startSec: Math.round(startSec),
    endSec: Math.round(endSec),
    score: Number(score.toFixed(2)),
    reason: 'audio_rms_spike',
    spikeAtSec: Math.round(spikeMidSec),
  };
}
