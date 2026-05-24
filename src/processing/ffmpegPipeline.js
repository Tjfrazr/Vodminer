import { mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { video } from '../../config.js';
import { logger } from '../lib/logger.js';

const CLIPS_DIR = path.resolve('clips');

function escapeSubtitlesPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildDrawtextFilters(captions) {
  return captions.map((c) => {
    const text = String(c.text)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");
    const enable = `between(t,${Number(c.startSec)},${Number(c.endSec)})`;
    return (
      `drawtext=text='${text}'` +
      `:fontcolor=white:fontsize=56:borderw=4:bordercolor=black` +
      `:x=(w-text_w)/2:y=h-(text_h*3)` +
      `:enable='${enable}'`
    );
  });
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function validateOutput(filePath, expectedDurationSec) {
  const data = await probe(filePath);
  const format = data.format ?? {};
  const streams = data.streams ?? [];
  const vStream = streams.find((s) => s.codec_type === 'video');
  if (!vStream) throw new Error('output validation failed: no video stream');

  const duration = Number(format.duration ?? vStream.duration ?? 0);
  if (!Number.isFinite(duration) || duration > video.maxDurationSec + 0.5) {
    throw new Error(
      `output validation failed: duration ${duration}s exceeds max ${video.maxDurationSec}s`,
    );
  }
  if (vStream.width !== video.width || vStream.height !== video.height) {
    throw new Error(
      `output validation failed: resolution ${vStream.width}x${vStream.height} != ${video.width}x${video.height}`,
    );
  }
  if (vStream.codec_name !== 'h264') {
    throw new Error(`output validation failed: codec ${vStream.codec_name} != h264`);
  }
  const formatName = String(format.format_name ?? '');
  if (!formatName.includes('mp4')) {
    throw new Error(`output validation failed: container ${formatName} not mp4`);
  }
  const fileStat = await stat(filePath);
  if (fileStat.size > video.maxSizeBytes) {
    throw new Error(
      `output validation failed: size ${fileStat.size} exceeds ${video.maxSizeBytes}`,
    );
  }
  return { duration, size: fileStat.size };
}

export default async function process(highlight, sourceVideoPath, captions) {
  if (!highlight || typeof highlight !== 'object') {
    throw new Error('process: highlight is required');
  }
  if (!sourceVideoPath) {
    throw new Error('process: sourceVideoPath is required');
  }

  const start = Number(highlight.startSec);
  const end = Number(highlight.endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`process: invalid highlight range [${start}, ${end}]`);
  }

  const rawDuration = end - start;
  const duration = Math.min(rawDuration, video.maxDurationSec);

  await mkdir(CLIPS_DIR, { recursive: true });
  const outputPath = path.join(
    CLIPS_DIR,
    `${highlight.vodId}-${start}-${end}.mp4`,
  );

  const cropChain =
    'scale=if(gt(a\\,9/16)\\,-2\\,1080):if(gt(a\\,9/16)\\,1920\\,-2),' +
    'crop=1080:1920,' +
    'pad=1080:1920:(1080-iw)/2:(1920-ih)/2:color=black,' +
    'setsar=1';

  const filters = [cropChain];
  if (Array.isArray(captions) && captions.length > 0) {
    filters.push(...buildDrawtextFilters(captions));
  }
  const videoFilter = filters.join(',');

  logger.info(
    {
      vodId: highlight.vodId,
      start,
      end,
      duration,
      outputPath,
      hasCaptions: Array.isArray(captions) && captions.length > 0,
    },
    'ffmpeg: starting clip processing',
  );

  await new Promise((resolve, reject) => {
    ffmpeg(sourceVideoPath)
      .setDuration(video.maxDurationSec)
      .videoCodec(video.codec)
      .audioCodec('aac')
      .videoFilters(videoFilter)
      .outputOptions(['-preset veryfast', '-crf 23', '-movflags +faststart'])
      .format(video.container)
      .on('start', (cmd) => logger.debug({ cmd }, 'ffmpeg: command'))
      .on('stderr', (line) => logger.trace({ line }, 'ffmpeg: stderr'))
      .on('error', (err) => {
        logger.error({ err: err.message }, 'ffmpeg: failed');
        reject(err);
      })
      .on('end', () => resolve())
      .save(outputPath);
  });

  const { duration: actualDuration } = await validateOutput(outputPath, duration);

  const clip = {
    id: randomUUID(),
    filePath: outputPath,
    sourceVodId: highlight.vodId,
    durationSec: actualDuration,
    createdAt: new Date().toISOString(),
  };

  logger.info({ clipId: clip.id, filePath: clip.filePath }, 'ffmpeg: clip ready');
  return clip;
}

export { CLIPS_DIR };
