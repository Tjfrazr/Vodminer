import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadVodSegment } from '../twitch/vodFetcher.js';
import { logger } from '../lib/logger.js';

const COMPRESS_TIMEOUT_MS = 5 * 60 * 1000;

// Target 9MB, not the full 10MB, to leave headroom for container/moov-atom
// overhead — landing at 9.9MB estimated and 10.1MB actual is exactly the
// "Request entity too large" failure this exists to prevent.
const TARGET_BYTES = 9 * 1024 * 1024;
const AUDIO_KBPS = 96;
const MIN_VIDEO_KBPS = 300; // floor so a long clip degrades gracefully instead of becoming unwatchable

// Builds a small, Discord-attachable preview of a VOD segment for manual
// review/grading in reviewBot — raw landscape footage, no crop or captions.
// This is NOT the TikTok/YouTube-ready 9:16 render (see processing/ffmpegPipeline.js).
// Video bitrate is computed from the actual clip duration (Discord's real
// free-tier cap is 10MB as of late 2024, not the 25MB this used to assume) —
// a fixed bitrate was fine for short clips but silently produced ~16MB files
// for 45s+ clips, which Discord rejected with no useful error client-side.
export async function buildPreviewClip(vodId, startSec, endSec) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-preview-'));
  const rawPath = path.join(dir, 'raw.mp4');
  const outPath = path.join(dir, 'preview.mp4');
  try {
    await downloadVodSegment(vodId, startSec, endSec, rawPath);
    await compress(rawPath, outPath, endSec - startSec);
    return { filePath: outPath, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function compress(inPath, outPath, durationSec) {
  const totalKbps = Math.floor((TARGET_BYTES * 8) / 1000 / durationSec);
  const videoKbps = Math.max(MIN_VIDEO_KBPS, totalKbps - AUDIO_KBPS);
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '26',
      '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
      '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-movflags', '+faststart',
      outPath,
    ]);

    let ffErr = '';
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      if (err) reject(err); else resolve();
    }

    const timer = setTimeout(
      () => finish(new Error(`preview compress timed out after ${COMPRESS_TIMEOUT_MS}ms`)),
      COMPRESS_TIMEOUT_MS,
    );

    ff.stderr.on('data', (d) => { ffErr += d.toString(); });
    ff.on('error', finish);
    ff.on('close', (code) => {
      if ((code ?? 0) !== 0) return finish(new Error(`ffmpeg exit ${code}: ${ffErr.slice(-500)}`));
      finish();
    });
  });
}

export default { buildPreviewClip };
