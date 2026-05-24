import { open, stat } from 'node:fs/promises';
import { fetch } from 'undici';
import { getAccessToken } from './auth.js';
import { logger } from '../lib/logger.js';

const API_BASE = 'https://open.tiktokapis.com';
const CHUNK_SIZE = 10 * 1024 * 1024;
const MIN_CHUNK = 5 * 1024 * 1024;

export async function initUpload(videoSizeBytes, postInfo) {
  const token = await getAccessToken();

  const totalChunkCount = Math.max(1, Math.ceil(videoSizeBytes / CHUNK_SIZE));
  // WHY: TikTok requires every chunk except the last to be >=5MB; if size split
  // produces a small final chunk we shrink chunk count so each chunk >=5MB.
  let chunkSize = CHUNK_SIZE;
  let chunkCount = totalChunkCount;
  if (videoSizeBytes <= CHUNK_SIZE) {
    chunkSize = videoSizeBytes;
    chunkCount = 1;
  } else if (videoSizeBytes % CHUNK_SIZE !== 0 && videoSizeBytes % CHUNK_SIZE < MIN_CHUNK) {
    chunkCount = Math.floor(videoSizeBytes / CHUNK_SIZE);
    chunkSize = Math.floor(videoSizeBytes / chunkCount);
  }

  // VERIFY: TikTok API v2 spec — direct-post init endpoint path.
  const body = {
    post_info: postInfo,
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSizeBytes,
      chunk_size: chunkSize,
      total_chunk_count: chunkCount,
    },
  };

  const res = await fetch(`${API_BASE}/v2/post/publish/video/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok initUpload failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // VERIFY: TikTok API v2 spec — response shape (data.upload_url, data.publish_id).
  const uploadUrl = data?.data?.upload_url;
  const publishId = data?.data?.publish_id;
  if (!uploadUrl || !publishId) {
    throw new Error(`TikTok initUpload returned unexpected payload: ${JSON.stringify(data)}`);
  }

  logger.info({ publishId, chunkCount, chunkSize }, 'TikTok upload initialized');
  return { uploadUrl, publishId, chunkSize, chunkCount, videoSize: videoSizeBytes };
}

async function putChunk(uploadUrl, buffer, start, end, total) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(buffer.length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
      body: buffer,
    });

    if (res.status >= 200 && res.status < 300) {
      return;
    }
    if (res.status >= 500 && attempt === 1) {
      logger.warn({ status: res.status, start, end }, 'TikTok chunk upload 5xx, retrying once');
      continue;
    }
    const text = await res.text();
    throw new Error(`TikTok chunk upload failed [${start}-${end}]: ${res.status} ${text}`);
  }
}

export async function uploadChunks(uploadUrl, filePath, chunkSize, chunkCount, videoSize) {
  const stats = await stat(filePath);
  const total = videoSize ?? stats.size;
  const size = chunkSize ?? CHUNK_SIZE;
  const count = chunkCount ?? Math.max(1, Math.ceil(total / size));

  const fh = await open(filePath, 'r');
  try {
    for (let i = 0; i < count; i += 1) {
      const start = i * size;
      const isLast = i === count - 1;
      const end = isLast ? total - 1 : start + size - 1;
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      await putChunk(uploadUrl, buf, start, end, total);
      logger.debug({ chunk: i + 1, of: count, bytes: length }, 'TikTok chunk uploaded');
    }
  } finally {
    await fh.close();
  }
}

export async function getStatus(publishId) {
  const token = await getAccessToken();
  // VERIFY: TikTok API v2 spec — status fetch endpoint and field names.
  const res = await fetch(`${API_BASE}/v2/post/publish/status/fetch/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok getStatus failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const status = data?.data?.status;
  return { status, raw: data?.data || data };
}

export default { initUpload, uploadChunks, getStatus };
