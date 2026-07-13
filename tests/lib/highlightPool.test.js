import { jest } from '@jest/globals';

// Mocked so this test never touches the real state/ directory — same
// hermetic-test rationale as env.test.js's dotenv mock.
const store = {};
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn(async (p) => {
    if (store[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return store[p];
  }),
  writeFile: jest.fn(async (p, data) => { store[p] = data; }),
  mkdir: jest.fn(async () => {}),
}));

const { saveReservePool, loadReservePool } = await import('../../src/lib/highlightPool.js');

describe('highlightPool', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('returns null for a vodId with no saved pool', async () => {
    expect(await loadReservePool('v1')).toBeNull();
  });

  it('round-trips a saved pool', async () => {
    const poolData = {
      vod: { vodId: 'v1', url: 'https://twitch.tv/videos/v1', durationSec: 100 },
      gameName: 'Forza Horizon 6',
      highlights: [{ startSec: 10, endSec: 20, score: 3 }],
    };
    await saveReservePool('v1', poolData);
    expect(await loadReservePool('v1')).toEqual(poolData);
  });

  it('clears the pool when given null', async () => {
    await saveReservePool('v1', { vod: {}, gameName: null, highlights: [{ startSec: 1, endSec: 2, score: 1 }] });
    await saveReservePool('v1', null);
    expect(await loadReservePool('v1')).toBeNull();
  });

  it('clears the pool when given an empty highlights array', async () => {
    await saveReservePool('v1', { vod: {}, gameName: null, highlights: [{ startSec: 1, endSec: 2, score: 1 }] });
    await saveReservePool('v1', { vod: {}, gameName: null, highlights: [] });
    expect(await loadReservePool('v1')).toBeNull();
  });

  it('keeps pools for different vodIds independent', async () => {
    await saveReservePool('v1', { vod: {}, gameName: 'A', highlights: [{ startSec: 1, endSec: 2, score: 1 }] });
    await saveReservePool('v2', { vod: {}, gameName: 'B', highlights: [{ startSec: 3, endSec: 4, score: 2 }] });
    expect((await loadReservePool('v1')).gameName).toBe('A');
    expect((await loadReservePool('v2')).gameName).toBe('B');
  });
});
