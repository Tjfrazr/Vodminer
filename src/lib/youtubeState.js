import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Mirrors state/processed-vods.json's pattern for the Twitch path — without
// this, re-running either YouTube upload script re-uploads the same VOD as a
// brand-new video. With auto-publish (no approval gate) and YouTube's daily
// upload quota, a couple of accidental re-runs both burns quota and litters
// the channel with duplicates.
const STATE_FILE = path.resolve('state', 'youtube-uploaded.json');

async function load() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { vod: [], short: [] };
  }
}

async function save(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// kind is 'vod' (Path A, full edited VOD) or 'short' (Path B, per-highlight Short).
export async function hasUploaded(kind, vodId) {
  const state = await load();
  return (state[kind] ?? []).includes(vodId);
}

export async function markUploaded(kind, vodId) {
  const state = await load();
  const set = new Set(state[kind] ?? []);
  set.add(vodId);
  state[kind] = [...set];
  await save(state);
}

export default { hasUploaded, markUploaded };
