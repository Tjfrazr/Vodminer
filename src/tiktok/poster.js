import { stat } from 'node:fs/promises';
import { getAccessToken } from './auth.js';
import { initUpload, uploadChunks, getStatus } from './uploader.js';
import { tiktok as tiktokConfig } from '../../config.js';
import { logger } from '../lib/logger.js';

const POLL_INITIAL_MS = 2000;
const POLL_MAX_MS = 30000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function buildTitle(caption, hashtags) {
  const tagStr = (hashtags || []).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
  const title = [caption, tagStr].filter(Boolean).join(' ').trim();
  // VERIFY: TikTok API v2 spec — title max length (commonly 2200 chars).
  return title.slice(0, 2200);
}

async function pollUntilDone(publishId) {
  const startedAt = Date.now();
  let delay = POLL_INITIAL_MS;
  for (;;) {
    const { status, raw } = await getStatus(publishId);
    logger.debug({ publishId, status }, 'TikTok publish status');

    if (status === 'PUBLISH_COMPLETE') {
      return raw;
    }
    if (status === 'FAILED') {
      throw new Error(`TikTok publish FAILED: ${JSON.stringify(raw)}`);
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(`TikTok publish timed out after ${POLL_TIMEOUT_MS}ms (last status: ${status})`);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

export async function post(job, clip) {
  if (!clip?.filePath) {
    throw new Error('post(): clip.filePath required');
  }

  await getAccessToken();

  const stats = await stat(clip.filePath);
  const title = buildTitle(job.caption, job.hashtags);

  const postInfo = {
    title,
    // WHY: app may be in unaudited mode initially — flip to SELF_ONLY if posts fail with that error code.
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_duet: false,
    disable_comment: false,
    disable_stitch: false,
    video_cover_timestamp_ms: 1000,
    // NON-NEGOTIABLE per plan: raw stream footage is not AI-generated.
    is_ai_generated: tiktokConfig.isAiGenerated === true,
  };

  logger.info({ clipId: job.clipId, bytes: stats.size }, 'TikTok post starting');

  const { uploadUrl, publishId, chunkSize, chunkCount, videoSize } = await initUpload(stats.size, postInfo);

  await uploadChunks(uploadUrl, clip.filePath, chunkSize, chunkCount, videoSize);

  await pollUntilDone(publishId);

  const postedAt = new Date().toISOString();
  logger.info({ clipId: job.clipId, publishId, postedAt }, 'TikTok post complete');
  return { publishId, postedAt };
}

export default { post };
