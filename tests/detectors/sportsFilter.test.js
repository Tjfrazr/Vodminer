import '../__fixtures__/setEnv.js';
import { categorizeSportsHighlights, isSportsGame } from '../../src/detectors/sportsFilter.js';

const vod = { vodId: 'v1', url: 'https://www.twitch.tv/videos/v1', durationSec: 3600 };
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });

describe('isSportsGame', () => {
  it('matches known sports titles regardless of case or edition', () => {
    expect(isSportsGame('EA Sports FC 26')).toBe(true);
    expect(isSportsGame('FIFA 23')).toBe(true);
    expect(isSportsGame('Madden NFL 26')).toBe(true);
    expect(isSportsGame('NBA 2K26')).toBe(true);
    expect(isSportsGame('MLB The Show 26')).toBe(true);
    expect(isSportsGame('NHL 26')).toBe(true);
    expect(isSportsGame('ROCKET LEAGUE')).toBe(true);
    expect(isSportsGame('EA Sports College Football 26')).toBe(true);
  });

  it('does not match non-sports games (including management sims)', () => {
    expect(isSportsGame('God of War')).toBe(false);
    expect(isSportsGame('Forza Horizon 5')).toBe(false);
    expect(isSportsGame('Ready or Not')).toBe(false);
    expect(isSportsGame('Football Manager 2024')).toBe(false);
    expect(isSportsGame('Stardew Valley')).toBe(false);
  });

  it('returns false for missing game name', () => {
    expect(isSportsGame(null)).toBe(false);
    expect(isSportsGame('')).toBe(false);
    expect(isSportsGame(undefined)).toBe(false);
  });
});

describe('categorizeSportsHighlights', () => {
  const counting = (impl) => {
    const fn = async (...args) => { fn.calls += 1; return impl(...args); };
    fn.calls = 0;
    return fn;
  };

  it('passes non-sports games through without categorizing', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => 'CELEBRATION');
    const out = await categorizeSportsHighlights(hl, { vod, gameName: 'God of War', categorize });
    expect(out).toEqual(hl);
    expect(categorize.calls).toBe(0);
  });

  it('never drops a highlight — only labels or leaves it unlabeled', async () => {
    const goal = audio(100, 160, 3);
    const unmatched = audio(500, 560, 2);
    const categorize = counting(async (h) => (h.startSec === 100 ? 'SCORE_BANNER' : null));
    const out = await categorizeSportsHighlights([goal, unmatched], { vod, gameName: 'EA Sports FC 26', categorize });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startSec: 100, category: 'SCORE_BANNER' });
    expect(out[1]).toEqual(unmatched); // no category field added when null
  });

  it('categorizes viewer clips too (unlike combatFilter, nothing is exempt)', async () => {
    const human = viewer(100, 160, 999);
    const categorize = counting(async () => 'CELEBRATION');
    const out = await categorizeSportsHighlights([human], { vod, gameName: 'NBA 2K26', categorize });
    expect(categorize.calls).toBe(1);
    expect(out[0].category).toBe('CELEBRATION');
  });

  it('keeps a highlight unlabeled when categorize throws (fail open)', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => { throw new Error('ollama unreachable'); });
    const out = await categorizeSportsHighlights(hl, { vod, gameName: 'Madden NFL 26', categorize });
    expect(out).toEqual(hl);
  });

  it('returns empty input unchanged', async () => {
    expect(await categorizeSportsHighlights([], { vod, gameName: 'EA Sports FC 26' })).toEqual([]);
  });
});
