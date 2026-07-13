import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const POOL_FILE = path.resolve('state', 'highlight-pool.json');

// mergeHighlights caps each VOD at maxHighlightsPerVod and used to just
// discard everything below the cutoff. This persists that discarded tail
// (per VOD, score-ranked) so a clip deleted for a low rating or disapproval
// can be replaced from real detected candidates instead of the pool
// permanently shrinking every time someone rates something badly.
async function loadAll() {
  try { return JSON.parse(await readFile(POOL_FILE, 'utf8')); } catch { return {}; }
}

async function saveAll(all) {
  await mkdir(path.dirname(POOL_FILE), { recursive: true });
  await writeFile(POOL_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

// poolData: { vod: { vodId, url, durationSec }, gameName, highlights: [...] }
// Pass null (or an empty highlights array) to clear the pool for a vodId.
export async function saveReservePool(vodId, poolData) {
  const all = await loadAll();
  if (!poolData || !poolData.highlights?.length) delete all[vodId];
  else all[vodId] = poolData;
  await saveAll(all);
}

export async function loadReservePool(vodId) {
  const all = await loadAll();
  return all[vodId] ?? null;
}
