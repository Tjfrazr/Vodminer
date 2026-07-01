import '../__fixtures__/setEnv.js';
import { parseSceneEvents, groupSceneEvents, buildMotionHighlight } from '../../src/detectors/motionDetector.js';

// Real output captured from: ffmpeg ... select=gt(scene\,0.4),metadata=print
const FFMPEG_META = `frame:0    pts:12      pts_time:6
lavfi.scene_score=0.400000
frame:1    pts:18      pts_time:9
lavfi.scene_score=1.000000
`;

describe('parseSceneEvents', () => {
  it('pairs pts_time with the following lavfi.scene_score', () => {
    expect(parseSceneEvents(FFMPEG_META)).toEqual([
      { timeSec: 6, score: 0.4 },
      { timeSec: 9, score: 1 },
    ]);
  });

  it('returns empty for empty or non-matching text', () => {
    expect(parseSceneEvents('')).toEqual([]);
    expect(parseSceneEvents('nothing here\n')).toEqual([]);
  });
});

describe('groupSceneEvents', () => {
  it('clusters events within groupGapSec, keeping the peak score', () => {
    const events = [{ timeSec: 6, score: 0.4 }, { timeSec: 9, score: 1 }];
    expect(groupSceneEvents(events, 8)).toEqual([{ startSec: 6, endSec: 9, peakScore: 1 }]);
  });

  it('splits events farther apart than groupGapSec', () => {
    const events = [{ timeSec: 6, score: 0.4 }, { timeSec: 9, score: 1 }];
    expect(groupSceneEvents(events, 2)).toHaveLength(2);
  });
});

describe('buildMotionHighlight', () => {
  it('produces a motion highlight scaled from the peak scene score', () => {
    const vod = { vodId: 'v1', durationSec: 3600 };
    const h = buildMotionHighlight({ startSec: 100, endSec: 110, peakScore: 0.8 }, vod);
    expect(h.reason).toBe('motion');
    expect(h.vodId).toBe('v1');
    expect(h.score).toBe(4); // 0.8 * scoreScale(5)
    expect(h.endSec).toBeGreaterThan(h.startSec);
    expect(h.startSec).toBeGreaterThanOrEqual(0);
  });
});
