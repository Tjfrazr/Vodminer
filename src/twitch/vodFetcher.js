import { fetch } from 'undici';
import { spawn } from 'node:child_process';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2/token';
const REFRESH_LEAD_MS = 5 * 60 * 1000;

let cachedToken = null;
let cachedExpiresAt = 0;

export async function getAppAccessToken() {
  if (cachedToken && Date.now() < cachedExpiresAt - REFRESH_LEAD_MS) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`twitch oauth failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  cachedExpiresAt = Date.now() + Number(json.expires_in ?? 0) * 1000;
  logger.info({ expiresInSec: json.expires_in }, 'twitch app access token refreshed');
  return cachedToken;
}

async function helixGet(path, params = {}) {
  const token = await getAppAccessToken();
  const url = new URL(`${HELIX}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      'Client-Id': env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`twitch helix ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function parseDurationToSec(duration) {
  if (typeof duration !== 'string') return 0;
  const re = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  const m = duration.match(re);
  if (!m) return 0;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + min * 60 + s;
}

function shapeVod(vid) {
  return {
    vodId: vid.id,
    url: vid.url,
    durationSec: parseDurationToSec(vid.duration),
    createdAt: vid.created_at,
  };
}

export async function getLatestVod(broadcasterId) {
  const data = await helixGet('/videos', {
    user_id: broadcasterId,
    type: 'archive',
    first: 1,
  });
  const vid = data?.data?.[0];
  return vid ? shapeVod(vid) : null;
}

export async function getAllVods(broadcasterId, { onPage } = {}) {
  const all = [];
  let cursor;
  let page = 0;
  do {
    const data = await helixGet('/videos', {
      user_id: broadcasterId,
      type: 'archive',
      first: 100,
      after: cursor,
    });
    const batch = (data?.data ?? []).map(shapeVod);
    all.push(...batch);
    page += 1;
    if (typeof onPage === 'function') onPage({ page, batchSize: batch.length, total: all.length });
    cursor = data?.pagination?.cursor;
  } while (cursor);
  return all;
}

export async function getVodGameName(vodId) {
  const url = `https://www.twitch.tv/videos/${vodId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html',
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  // og:description / twitter:description format:
  //   "<user> went live on Twitch. Catch up on their <GAME> VOD now."
  const m = /Catch up on their (.+?) VOD now/i.exec(html);
  if (!m || !m[1]) return null;
  // Twitch HTML-encodes apostrophes etc; decode the few common entities.
  return m[1]
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

export async function getViewerClipsForVod(broadcasterId, vodId, { maxPages = 5 } = {}) {
  const out = [];
  let cursor;
  let page = 0;
  do {
    const data = await helixGet('/clips', {
      broadcaster_id: broadcasterId,
      first: 100,
      after: cursor,
    });
    const batch = data?.data ?? [];
    for (const c of batch) {
      if (c.video_id !== String(vodId)) continue;
      const offset = Number(c.vod_offset);
      const duration = Number(c.duration);
      if (!Number.isFinite(offset) || !Number.isFinite(duration) || duration <= 0) continue;
      out.push({
        clipId: c.id,
        title: c.title,
        creatorName: c.creator_name,
        viewCount: Number(c.view_count) || 0,
        vodOffsetSec: Math.max(0, Math.floor(offset)),
        durationSec: Math.floor(duration),
      });
    }
    page += 1;
    cursor = data?.pagination?.cursor;
  } while (cursor && page < maxPages);
  return out;
}

export async function downloadVodSegment(vodId, startSec, endSec, outPath) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error(`invalid segment range: ${startSec}-${endSec}`);
  }

  const url = `https://www.twitch.tv/videos/${vodId}`;
  const args = [
    '--download-sections',
    `*${startSec}-${endSec}`,
    '-o',
    outPath,
    url,
  ];

  logger.info({ vodId, startSec, endSec, outPath }, 'downloading vod segment via yt-dlp');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(
        new Error(
          `yt-dlp not found on PATH. Install it (https://github.com/yt-dlp/yt-dlp) and ensure it is on the system PATH. Original: ${err.message}`,
        ),
      );
      return;
    }

    let stderr = '';
    child.stdout.on('data', (d) => logger.debug({ ytdlp: d.toString().trim() }));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'yt-dlp not found on PATH. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) and ensure it is on the system PATH.',
          ),
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(outPath);
        return;
      }
      reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export default { getAppAccessToken, getLatestVod, getAllVods, getVodGameName, getViewerClipsForVod, downloadVodSegment };
