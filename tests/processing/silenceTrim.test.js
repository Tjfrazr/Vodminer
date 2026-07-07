import '../__fixtures__/setEnv.js';
import { parseSilenceIntervals, buildKeepRanges, mapToTrimmedTime } from '../../src/processing/silenceTrim.js';

describe('parseSilenceIntervals', () => {
  it('pairs silence_start with the following silence_end', () => {
    const text = 'silence_start: 5.2\nsilence_end: 9.4 | silence_duration: 4.2\n';
    expect(parseSilenceIntervals(text)).toEqual([{ start: 5.2, end: 9.4 }]);
  });

  it('handles multiple intervals and ignores unrelated lines', () => {
    const text = [
      'Input #0, mov...',
      'silence_start: 10',
      'silence_end: 12.5 | silence_duration: 2.5',
      'silence_start: 40',
      'silence_end: 41 | silence_duration: 1',
    ].join('\n');
    expect(parseSilenceIntervals(text)).toEqual([
      { start: 10, end: 12.5 },
      { start: 40, end: 41 },
    ]);
  });

  it('returns empty for text with no silence markers', () => {
    expect(parseSilenceIntervals('nothing here')).toEqual([]);
    expect(parseSilenceIntervals('')).toEqual([]);
  });
});

describe('buildKeepRanges', () => {
  it('inverts a single silence interval into two keep ranges', () => {
    const silences = [{ start: 10, end: 20 }];
    const keep = buildKeepRanges(silences, 100, { padSec: 0 });
    expect(keep).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 100 },
    ]);
  });

  it('drops a leading keep range when silence starts at 0', () => {
    const silences = [{ start: 0, end: 5 }];
    const keep = buildKeepRanges(silences, 50, { padSec: 0 });
    expect(keep).toEqual([{ start: 5, end: 50 }]);
  });

  it('drops a trailing keep range when silence runs to the end', () => {
    const silences = [{ start: 45, end: 50 }];
    const keep = buildKeepRanges(silences, 50, { padSec: 0 });
    expect(keep).toEqual([{ start: 0, end: 45 }]);
  });

  it('applies padding to shrink the cut (grow the kept edges)', () => {
    const silences = [{ start: 10, end: 20 }];
    const keep = buildKeepRanges(silences, 100, { padSec: 1 });
    expect(keep).toEqual([
      { start: 0, end: 11 },
      { start: 19, end: 100 },
    ]);
  });

  it('drops a sub-0.1s sliver left between two closely-spaced silences', () => {
    const silences = [
      { start: 10, end: 20 },
      { start: 20.05, end: 30 },
    ];
    const keep = buildKeepRanges(silences, 100, { padSec: 0 });
    // Without the filter this would include a spurious {20, 20.05} kept range.
    expect(keep).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 100 },
    ]);
  });
});

describe('mapToTrimmedTime', () => {
  const keepRanges = [
    { start: 0, end: 20 },
    { start: 30, end: 60 },
    { start: 65, end: 100 },
  ];

  it('maps a timestamp inside the first kept range with no shift', () => {
    expect(mapToTrimmedTime(5, keepRanges)).toBe(5);
  });

  it('returns null for a timestamp inside a cut gap', () => {
    expect(mapToTrimmedTime(25, keepRanges)).toBeNull();
    expect(mapToTrimmedTime(62, keepRanges)).toBeNull();
  });

  it('accumulates the offset of prior kept ranges for a later range', () => {
    // second range starts at trimmed-time 20 (length of first range);
    // orig 45 is 15s into the second range -> trimmed 20+15=35
    expect(mapToTrimmedTime(45, keepRanges)).toBe(35);
    // third range starts at trimmed-time 20+30=50; orig 90 is 25s into it -> 75
    expect(mapToTrimmedTime(90, keepRanges)).toBe(75);
  });

  it('returns null for a timestamp past the last kept range', () => {
    expect(mapToTrimmedTime(150, keepRanges)).toBeNull();
  });
});
