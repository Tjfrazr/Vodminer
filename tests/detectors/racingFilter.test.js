import '../__fixtures__/setEnv.js';
import { categorizeRacingHighlights, isRacingGame } from '../../src/detectors/racingFilter.js';

const vod = { vodId: 'v1', url: 'https://www.twitch.tv/videos/v1', durationSec: 3600 };
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });

describe('isRacingGame', () => {
  it('matches known racing games regardless of case or subtitle', () => {
    expect(isRacingGame('Forza Horizon 5')).toBe(true);
    expect(isRacingGame('FORZA HORIZON 6')).toBe(true);
    expect(isRacingGame('Gran Turismo 7')).toBe(true);
    expect(isRacingGame('Mario Kart 8 Deluxe')).toBe(true);
  });

  it('does not match non-racing games', () => {
    expect(isRacingGame('God of War')).toBe(false);
    expect(isRacingGame('Stardew Valley')).toBe(false);
  });

  it('returns false for missing game name', () => {
    expect(isRacingGame(null)).toBe(false);
    expect(isRacingGame('')).toBe(false);
    expect(isRacingGame(undefined)).toBe(false);
  });
});

describe('categorizeRacingHighlights', () => {
  const counting = (impl) => {
    const fn = async (...args) => { fn.calls += 1; return impl(...args); };
    fn.calls = 0;
    return fn;
  };

  it('passes non-racing games through without categorizing', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => 'CRASH');
    const out = await categorizeRacingHighlights(hl, { vod, gameName: 'God of War', categorize });
    expect(out).toEqual(hl);
    expect(categorize.calls).toBe(0);
  });

  it('never drops a highlight — only labels or leaves it unlabeled', async () => {
    const crash = audio(100, 160, 3);
    const unmatched = audio(500, 560, 2);
    const categorize = counting(async (h) => (h.startSec === 100 ? 'CRASH' : null));
    const out = await categorizeRacingHighlights([crash, unmatched], { vod, gameName: 'Forza Horizon 6', categorize });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startSec: 100, category: 'CRASH' });
    expect(out[1]).toEqual(unmatched); // no category field added when null
  });

  it('categorizes viewer clips too (unlike combatFilter, nothing is exempt)', async () => {
    const human = viewer(100, 160, 999);
    const categorize = counting(async () => 'OVERTAKE');
    const out = await categorizeRacingHighlights([human], { vod, gameName: 'Forza Horizon 6', categorize });
    expect(categorize.calls).toBe(1);
    expect(out[0].category).toBe('OVERTAKE');
  });

  it('keeps a highlight unlabeled when categorize throws (fail open)', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => { throw new Error('ollama unreachable'); });
    const out = await categorizeRacingHighlights(hl, { vod, gameName: 'Forza Horizon 6', categorize });
    expect(out).toEqual(hl);
  });

  it('returns empty input unchanged', async () => {
    expect(await categorizeRacingHighlights([], { vod, gameName: 'Forza Horizon 6' })).toEqual([]);
  });
});
