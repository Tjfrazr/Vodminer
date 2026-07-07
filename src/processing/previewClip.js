import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadVodSegment } from '../twitch/vodFetcher.js';
import { logger } from '../lib/logger.js';

const COMPRESS_TIMEOUT_MS = 5 * 60 * 1000;

// Builds a small, Discord-attachable preview of a VOD segment for manual
// review/grading in reviewBot — raw landscape footage, no crop or captions,
// just compressed enough to clear Discord's 25MB free-tier attachment limit.
// This is NOT the TikTok/YouTube-ready 9:16 render (see processing/ffmpegPipeline.js) —
// Twitch only offers a "Source" (720p) or Audio_Only rendition for VODs, and a raw
// 45-90s Source-quality segment runs ~30MB+, over the limit, so a compress pass is
// required even though nothing is being cropped.
export async function buildPreviewClip(vodId, startSec, endSec) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vodminer-preview-'));
  const rawPath = path.join(dir, 'raw.mp4');
  const outPath = path.join(dir, 'preview.mp4');
  try {
    await downloadVodSegment(vodId, startSec, endSec, rawPath);
    await compress(rawPath, outPath);
    return { filePath: outPath, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function compress(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '26',
      '-maxrate', '2800k', '-bufsize', '5600k',
      '-c:a', 'aac', '-movflags', '+faststart',
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
