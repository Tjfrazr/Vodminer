import '../__fixtures__/setEnv.js';
import { mergeHighlights, mergeHighlightsWithReserve } from '../../src/detectors/merge.js';

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

describe('mergeHighlightsWithReserve', () => {
  it('returns the same accepted list mergeHighlights would', () => {
    const hl = [audio(900, 960, 1), audio(100, 160, 9), audio(500, 560, 5)];
    const { accepted } = mergeHighlightsWithReserve(hl, { vod, maxHighlights: 2 });
    expect(accepted).toEqual(mergeHighlights(hl, { vod, maxHighlights: 2 }));
  });

  it('returns everything the cap dropped, score-ranked highest first', () => {
    const hl = [audio(900, 960, 1), audio(100, 160, 9), audio(500, 560, 5), audio(700, 760, 7)];
    const { reserve } = mergeHighlightsWithReserve(hl, { vod, maxHighlights: 2 });
    // top 2 by score (9, 7) are accepted; reserve is what's left, still score-ranked
    expect(reserve.map((h) => h.score)).toEqual([5, 1]);
  });

  it('reserve is empty when nothing exceeds the cap', () => {
    const { reserve } = mergeHighlightsWithReserve([audio(100, 160, 3)], { vod, maxHighlights: 5 });
    expect(reserve).toEqual([]);
  });

  it('excludes banned-range highlights from the reserve too, not just accepted', () => {
    const bannedRanges = [{ vodId: 'v1', startSec: 210, endSec: 250 }];
    const { accepted, reserve } = mergeHighlightsWithReserve(
      [audio(100, 160, 9), audio(200, 260, 5)],
      { vod, bannedRanges, maxHighlights: 1 },
    );
    expect(accepted.map((h) => h.startSec)).toEqual([100]);
    expect(reserve).toEqual([]); // the banned one must not resurface via the reserve
  });

  it('a category weight can flip which of two close-scored candidates gets accepted', () => {
    const low = { ...audio(100, 160, 5), category: 'DRIFT' };
    const high = { ...audio(500, 560, 6), category: 'CRASH' };
    const noWeights = mergeHighlightsWithReserve([low, high], { vod, maxHighlights: 1 });
    expect(noWeights.accepted[0].category).toBe('CRASH'); // raw score wins with no history

    const weighted = mergeHighlightsWithReserve([low, high], {
      vod,
      maxHighlights: 1,
      categoryWeights: { DRIFT: 1.5, CRASH: 0.5 },
    });
    expect(weighted.accepted[0].category).toBe('DRIFT'); // 5*1.5=7.5 beats 6*0.5=3
  });

  it('falls back to reason for weighting when category is absent', () => {
    const hl = [audio(100, 160, 5), audio(500, 560, 6)];
    const { accepted } = mergeHighlightsWithReserve(hl, {
      vod,
      maxHighlights: 1,
      categoryWeights: { audio_transient: 2 },
    });
    // both share reason 'audio_transient', so the weight applies equally — raw score still decides
    expect(accepted[0].startSec).toBe(500);
  });
});
