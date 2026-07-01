import '../__fixtures__/setEnv.js';
import { mergeHighlights } from '../../src/detectors/merge.js';

const vod = { vodId: 'v1', durationSec: 3600 };
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });

describe('mergeHighlights', () => {
  it('drops an algorithmic highlight overlapping a higher-scored viewer clip', () => {
    const out = mergeHighlights([viewer(100, 160, 999), audio(115, 145, 3)], { vod });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('viewer_clip');
  });

  it('keeps non-overlapping highlights from different detectors', () => {
    const out = mergeHighlights([viewer(100, 160, 999), audio(500, 560, 3)], { vod });
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.startSec)).toEqual([100, 500]); // sorted ascending
  });

  it('filters highlights overlapping a banned range for this vod', () => {
    const bannedRanges = [{ vodId: 'v1', startSec: 210, endSec: 250 }];
    const out = mergeHighlights([audio(200, 260, 5)], { vod, bannedRanges });
    expect(out).toHaveLength(0);
  });

  it('ignores banned ranges belonging to a different vod', () => {
    const bannedRanges = [{ vodId: 'other', startSec: 210, endSec: 250 }];
    const out = mergeHighlights([audio(200, 260, 5)], { vod, bannedRanges });
    expect(out).toHaveLength(1);
  });

  it('caps at maxHighlights keeping the highest-scored, then sorts by time', () => {
    const hl = [audio(900, 960, 1), audio(100, 160, 9), audio(500, 560, 5)];
    const out = mergeHighlights(hl, { vod, maxHighlights: 2 });
    expect(out.map((h) => h.score)).toEqual([9, 5]); // dropped the score-1 one
    expect(out.map((h) => h.startSec)).toEqual([100, 500]); // ascending time
  });

  it('returns empty for empty input', () => {
    expect(mergeHighlights([], { vod })).toEqual([]);
  });

  // Deliberate change vs the old merge (which emitted both): overlapping
  // same-source clips are now deduped to the higher-scored one.
  it('dedups overlapping same-source clips, keeping the higher-scored one', () => {
    const out = mergeHighlights([viewer(100, 160, 5), viewer(120, 180, 2)], { vod });
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBe(100); // score 999+5 beats 999+2
  });
});
