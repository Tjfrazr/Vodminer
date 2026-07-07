import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fetch } from 'undici';
import { google } from 'googleapis';
import { getAccessToken, getOAuth2Client } from './auth.js';
import { logger } from '../lib/logger.js';

// Hand-rolled implementation of YouTube's actual resumable upload protocol
// (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).
// The googleapis package's videos.insert does NOT do this — verified against
// the installed library's source (googleapis-common/build/src/apirequest.js):
// it always sends a single-shot multipart request, no session negotiation,
// no chunking, no resume-on-failure. That's fine for small/reliable uploads
// but defeats the entire point here — this app just spent a session fixing
// download failures on multi-GB files, and the first YouTube test VOD is an
// ~8GB video. A dropped connection at 95% must resume from 95%, not restart.
const UPLOAD_INIT_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const CHUNK_SIZE = 8 * 1024 * 1024; // multiple of 256 KiB, per Google's requirement
const MAX_CONSECUTIVE_CHUNK_RETRIES = 5; // give up on a chunk that fails this many times in a row at the same offset
const MAX_TOTAL_RETRIES = 50; // overall safety ceiling across the WHOLE upload (~1000 chunks for 8GB) —
// scattered transient blips over a long transfer shouldn't exhaust a small
// budget the way a per-chunk-only cap would; this only fires for a
// genuinely, persistently unstable connection.
const RETRY_BACKOFF_MS = 2000;

// initUrl is overridable so tests can point this at a local mock server
// instead of the real Google endpoint.
export async function initResumableSession(accessToken, { title, description, sizeBytes }, initUrl = UPLOAD_INIT_URL) {
  const res = await fetch(initUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(sizeBytes),
    },
    body: JSON.stringify({
      snippet: { title: title.slice(0, 100), description: (description ?? '').slice(0, 5000) },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    }),
  });
  if (!res.ok) {
    throw new Error(`youtube: failed to init resumable session: ${res.status} ${await res.text()}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('youtube: no Location header in resumable session init response');
  return location;
}

// Asks the server how many bytes it has actually received so far — used to
// recover the correct offset after a dropped connection, per the protocol's
// documented recovery flow.
async function queryReceivedBytes(sessionUrl, accessToken, sizeBytes) {
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Range': `bytes */${sizeBytes}`,
    },
  });
  if (res.status === 200 || res.status === 201) {
    return { done: true, body: await res.json() };
  }
  if (res.status === 308) {
    const range = res.headers.get('range'); // "bytes=0-8388607"
    const receivedEnd = range ? Number(range.split('-')[1]) : NaN;
    if (!Number.isFinite(receivedEnd)) {
      throw new Error(`youtube: 308 recovery response had no usable Range header (got "${range}")`);
    }
    return { done: false, nextOffset: receivedEnd + 1 };
  }
  throw new Error(`youtube: range query failed: ${res.status} ${await res.text()}`);
}

// The recovery query runs over the same connection that just failed — it can
// fail too. Give it its own small bounded retry so one flaky query doesn't
// abort an otherwise-recoverable multi-GB upload.
async function queryReceivedBytesWithRetry(sessionUrl, getToken, sizeBytes, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i += 1) {
    try {
      const token = await getToken();
      return await queryReceivedBytes(sessionUrl, token, sizeBytes);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (i + 1)));
    }
  }
  throw new Error(`youtube: recovery status query failed after ${retries} attempts: ${lastErr?.message}`);
}

export async function uploadChunks(sessionUrl, filePath, sizeBytes, getToken) {
  const fd = await open(filePath, 'r');
  try {
    let offset = 0;
    // Two separate budgets: chunkAttempts resets on every forward-progress
    // step, so a chunk that's genuinely stuck (same offset, repeated
    // failures) still fails fast — but scattered, recoverable blips spread
    // across an ~1000-chunk 8GB upload don't cumulatively exhaust a single
    // small counter the way one shared budget would. totalAttempts never
    // resets, as a ceiling against a connection that's persistently (if
    // intermittently) unstable for the whole transfer.
    let chunkAttempts = 0;
    let totalAttempts = 0;

    while (offset < sizeBytes) {
      const chunkLen = Math.min(CHUNK_SIZE, sizeBytes - offset);
      const end = offset + chunkLen - 1;

      try {
        const buf = Buffer.alloc(chunkLen);
        await fd.read(buf, 0, chunkLen, offset);
        const accessToken = await getToken();
        const res = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': String(chunkLen),
            'Content-Range': `bytes ${offset}-${end}/${sizeBytes}`,
          },
          body: buf,
        });

        if (res.status === 200 || res.status === 201) {
          return await res.json();
        }
        if (res.status === 308) {
          offset = end + 1;
          chunkAttempts = 0;
          continue;
        }
        throw new Error(`chunk PUT failed: ${res.status} ${await res.text()}`);
      } catch (err) {
        chunkAttempts += 1;
        totalAttempts += 1;
        if (chunkAttempts > MAX_CONSECUTIVE_CHUNK_RETRIES) {
          throw new Error(`youtube: chunk at offset ${offset} failed ${chunkAttempts} consecutive times: ${err.message}`);
        }
        if (totalAttempts > MAX_TOTAL_RETRIES) {
          throw new Error(`youtube: upload aborted after ${totalAttempts} total retries (persistently unstable connection): ${err.message}`);
        }
        logger.warn({ err: err.message, offset, chunkAttempts, totalAttempts }, 'youtube: chunk upload failed, attempting recovery');
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * chunkAttempts));
        // The server may have partially received this chunk before the failure —
        // ask it, rather than blindly re-sending from the same offset.
        const status = await queryReceivedBytesWithRetry(sessionUrl, getToken, sizeBytes);
        if (status.done) return status.body;
        offset = status.nextOffset;
      }
    }
    throw new Error('youtube: upload loop ended without a final response');
  } finally {
    await fd.close();
  }
}

// Uploads a local video file to YouTube as a private video (pre-audit
// visibility restriction is enforced by YouTube regardless of what's
// requested here — see docs/v2-phase2-youtube-architecture.md §4.10).
export async function uploadVideo({ filePath, sizeBytes, title, description, thumbnailPath }) {
  const accessToken = await getAccessToken();
  logger.info({ filePath, title, sizeBytes }, 'youtube: starting resumable upload');

  const sessionUrl = await initResumableSession(accessToken, { title, description, sizeBytes });
  const result = await uploadChunks(sessionUrl, filePath, sizeBytes, getAccessToken);

  const videoId = result.id;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  logger.info({ videoId, videoUrl }, 'youtube: upload complete');

  if (thumbnailPath) {
    try {
      // Thumbnails are small (<2MB) — the simple single-shot upload the
      // googleapis package does is genuinely fine here, no resumability need.
      const client = google.youtube({ version: 'v3', auth: getOAuth2Client() });
      await client.thumbnails.set({ videoId, media: { body: createReadStream(thumbnailPath) } });
      logger.info({ videoId }, 'youtube: thumbnail set');
    } catch (err) {
      logger.warn({ err: err?.message, videoId }, 'youtube: thumbnail set failed (non-fatal)');
    }
  }

  return { videoId, videoUrl };
}

export default { uploadVideo };
