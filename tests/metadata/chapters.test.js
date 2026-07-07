import '../__fixtures__/setEnv.js';
import { buildChapters } from '../../src/metadata/chapters.js';

describe('buildChapters', () => {
  it('forces the first chapter to 0:00 and labels subsequent ones by reason', () => {
    const highlights = [
      { startSec: 90, reason: 'audio_transient' },
      { startSec: 200, reason: 'motion' },
    ];
    const result = buildChapters(highlights, { totalDurationSec: 400 });
    expect(result.split('\n')).toEqual([
      '0:00 Stream Start',
      '1:30 Audio Highlight',
      '3:20 Action Moment',
    ]);
  });

  it('formats H:MM:SS once past the one-hour mark', () => {
    const highlights = [
      { startSec: 3661, reason: 'audio_transient' }, // 1h00m01s
      { startSec: 4000, reason: 'audio_transient' },
    ];
    const result = buildChapters(highlights, { totalDurationSec: 5000 });
    expect(result).toContain('1:01:01 Audio Highlight');
    expect(result).toContain('1:06:40 Audio Highlight 2');
  });

  it('numbers repeated reasons starting from the second occurrence', () => {
    const highlights = [
      { startSec: 20, reason: 'audio_transient' },
      { startSec: 40, reason: 'audio_transient' },
      { startSec: 60, reason: 'audio_transient' },
    ];
    const result = buildChapters(highlights, { totalDurationSec: 100 });
    expect(result.split('\n')).toEqual([
      '0:00 Stream Start',
      '0:20 Audio Highlight',
      '0:40 Audio Highlight 2',
      '1:00 Audio Highlight 3',
    ]);
  });

  it('drops a highlight less than 10s after the previous kept chapter', () => {
    const highlights = [
      { startSec: 20, reason: 'audio_transient' },
      { startSec: 25, reason: 'motion' }, // too close to 20, should be dropped
      { startSec: 60, reason: 'audio_transient' },
      { startSec: 200, reason: 'audio_transient' },
    ];
    const result = buildChapters(highlights, { totalDurationSec: 300 });
    expect(result).not.toContain('Action Moment');
    expect(result.split('\n')).toHaveLength(4); // 0:00 + 3 surviving highlights
  });

  it('drops a trailing chapter too close to the end of the video', () => {
    const highlights = [
      { startSec: 20, reason: 'audio_transient' },
      { startSec: 60, reason: 'audio_transient' },
      { startSec: 295, reason: 'motion' }, // within 10s of a 300s total -- should be dropped
    ];
    const result = buildChapters(highlights, { totalDurationSec: 300 });
    expect(result).not.toContain('Action Moment');
  });

  it('returns null when fewer than 3 chapters survive (YouTube requires >=3)', () => {
    const highlights = [{ startSec: 20, reason: 'audio_transient' }];
    expect(buildChapters(highlights, { totalDurationSec: 100 })).toBeNull();
  });

  it('returns null for an empty highlight list', () => {
    expect(buildChapters([], { totalDurationSec: 100 })).toBeNull();
  });

  it('sorts out-of-order highlights before building chapters', () => {
    const highlights = [
      { startSec: 200, reason: 'motion' },
      { startSec: 50, reason: 'audio_transient' },
      { startSec: 100, reason: 'viewer_clip' },
    ];
    const result = buildChapters(highlights, { totalDurationSec: 300 });
    const lines = result.split('\n');
    expect(lines[1]).toContain('0:50');
    expect(lines[2]).toContain('1:40');
    expect(lines[3]).toContain('3:20');
  });
});
