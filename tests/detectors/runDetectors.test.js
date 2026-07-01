import '../__fixtures__/setEnv.js';
import { runDetectors } from '../../src/detectors/index.js';

describe('runDetectors', () => {
  it('captures a per-detector error and keeps running the rest', async () => {
    const good = { name: 'good', detect: async () => [{ vodId: 'v', startSec: 1, endSec: 2, score: 1, reason: 'x' }] };
    const bad = { name: 'bad', detect: async () => { throw new Error('boom'); } };
    const res = await runDetectors({ vodId: 'v' }, [bad, good]);

    const badR = res.find((r) => r.name === 'bad');
    const goodR = res.find((r) => r.name === 'good');
    expect(badR.error).toBe('boom');
    expect(badR.highlights).toEqual([]);
    expect(goodR.highlights).toHaveLength(1);
    expect(goodR.error).toBeUndefined();
  });

  it('treats a detector returning null/undefined as no highlights', async () => {
    const nully = { name: 'nully', detect: async () => null };
    const [r] = await runDetectors({ vodId: 'v' }, [nully]);
    expect(r.highlights).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});
