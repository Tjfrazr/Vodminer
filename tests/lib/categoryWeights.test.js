import { jest } from '@jest/globals';
import path from 'node:path';

const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const store = {};
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn(async (p) => {
    if (store[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return store[p];
  }),
}));

const { computeCategoryWeights } = await import('../../src/lib/categoryWeights.js');

const clip = (overrides) => ({ vodId: 'v1', startSec: 0, endSec: 10, ...overrides });
const writeManifest = (clips) => { store[MANIFEST_FILE] = JSON.stringify({ clips }); };

describe('computeCategoryWeights', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('returns no weights when the manifest is missing', async () => {
    expect(await computeCategoryWeights()).toEqual({});
  });

  it('returns no weight for a key under the minimum sample size', async () => {
    writeManifest([clip({ category: 'CRASH', rating: 9 }), clip({ category: 'CRASH', rating: 9 })]);
    const weights = await computeCategoryWeights();
    expect(weights.CRASH).toBeUndefined();
  });

  it('gives a well-rated category a multiplier above 1', async () => {
    writeManifest([
      clip({ category: 'OVERTAKE', rating: 9 }),
      clip({ category: 'OVERTAKE', rating: 10 }),
      clip({ category: 'OVERTAKE', rating: 8 }),
    ]);
    const weights = await computeCategoryWeights();
    expect(weights.OVERTAKE).toBeGreaterThan(1);
    expect(weights.OVERTAKE).toBeLessThanOrEqual(1.5);
  });

  it('gives a consistently-disapproved category a multiplier below 1', async () => {
    writeManifest([
      clip({ category: 'DRIFT', disapproved: true }),
      clip({ category: 'DRIFT', disapproved: true }),
      clip({ category: 'DRIFT', disapproved: true }),
    ]);
    const weights = await computeCategoryWeights();
    expect(weights.DRIFT).toBeLessThan(1);
    expect(weights.DRIFT).toBeGreaterThanOrEqual(0.5);
  });

  it('falls back to reason when category is absent', async () => {
    writeManifest([
      clip({ reason: 'audio_transient', rating: 9 }),
      clip({ reason: 'audio_transient', rating: 9 }),
      clip({ reason: 'audio_transient', rating: 9 }),
    ]);
    const weights = await computeCategoryWeights();
    expect(weights.audio_transient).toBeGreaterThan(1);
  });

  it('ignores clips with neither a rating nor a disapproval', async () => {
    writeManifest([
      clip({ category: 'JUMP' }),
      clip({ category: 'JUMP' }),
      clip({ category: 'JUMP' }),
    ]);
    const weights = await computeCategoryWeights();
    expect(weights.JUMP).toBeUndefined();
  });

  it('mixed good and bad nets out closer to neutral', async () => {
    writeManifest([
      clip({ category: 'CRASH', rating: 9 }),
      clip({ category: 'CRASH', disapproved: true }),
      clip({ category: 'CRASH', rating: 9 }),
      clip({ category: 'CRASH', disapproved: true }),
    ]);
    const weights = await computeCategoryWeights();
    expect(weights.CRASH).toBe(1);
  });
});
