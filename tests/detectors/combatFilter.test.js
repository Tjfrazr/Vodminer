import '../__fixtures__/setEnv.js';
import {
  filterCombatHighlights,
  isActionGame,
  parseVerdict,
  frameTimes,
} from '../../src/detectors/combatFilter.js';

const vod = { vodId: 'v1', url: 'https://www.twitch.tv/videos/v1', durationSec: 3600 };
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });
const motion = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'motion' });
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });

describe('isActionGame', () => {
  it('matches known action games regardless of case or subtitle', () => {
    expect(isActionGame('God of War')).toBe(true);
    expect(isActionGame('God of War Ragnarök')).toBe(true);
    expect(isActionGame('ELDEN RING')).toBe(true);
    expect(isActionGame('Monster Hunter Wilds')).toBe(true);
  });

  it('does not match non-action games', () => {
    expect(isActionGame('Stardew Valley')).toBe(false);
    expect(isActionGame('Forza Horizon 5')).toBe(false);
    expect(isActionGame('Civilization VI')).toBe(false);
  });

  it('returns false for missing game name', () => {
    expect(isActionGame(null)).toBe(false);
    expect(isActionGame('')).toBe(false);
    expect(isActionGame(undefined)).toBe(false);
  });
});

describe('parseVerdict', () => {
  it('parses YES and NO case-insensitively', () => {
    expect(parseVerdict('YES')).toBe(true);
    expect(parseVerdict('yes')).toBe(true);
    expect(parseVerdict('NO')).toBe(false);
    expect(parseVerdict('no — this is a menu screen')).toBe(false);
  });

  it('returns null for ambiguous or garbage replies (fail open)', () => {
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict('maybe?')).toBeNull();
    expect(parseVerdict('YES or NO, hard to say')).toBeNull();
  });

  it('does not match YES/NO inside larger words', () => {
    expect(parseVerdict('EYES')).toBeNull();
    expect(parseVerdict('NOW')).toBeNull();
  });
});

describe('frameTimes', () => {
  it('samples evenly strictly inside the window', () => {
    expect(frameTimes(100, 180, 3)).toEqual([120, 140, 160]);
  });
});

describe('filterCombatHighlights', () => {
  // ESM jest exposes no `jest` global — a hand-rolled counter matches the
  // repo's plain-assertion style anyway.
  const counting = (impl) => {
    const fn = async (...args) => { fn.calls += 1; return impl(...args); };
    fn.calls = 0;
    return fn;
  };
  const asMenu = async () => false;

  it('passes everything through for non-action games without classifying', async () => {
    const hl = [audio(100, 160, 3), motion(500, 560, 2)];
    const classify = counting(asMenu);
    const out = await filterCombatHighlights(hl, { vod, gameName: 'Forza Horizon 5', classify });
    expect(out).toEqual(hl);
    expect(classify.calls).toBe(0);
  });

  it('drops highlights classified as not-combat for an action game', async () => {
    const keep = audio(100, 160, 3);
    const drop = motion(500, 560, 2);
    const classify = counting(async (h) => h.startSec === 100);
    const out = await filterCombatHighlights([keep, drop], { vod, gameName: 'God of War', classify });
    expect(out).toEqual([keep]);
    expect(classify.calls).toBe(2);
  });

  it('never classifies or drops viewer clips', async () => {
    const human = viewer(100, 160, 999);
    const algo = audio(500, 560, 3);
    const classify = counting(asMenu);
    const out = await filterCombatHighlights([human, algo], { vod, gameName: 'God of War', classify });
    expect(out).toEqual([human]);
    expect(classify.calls).toBe(1); // only the algorithmic one
  });

  it('keeps a highlight when classification throws — e.g. Ollama unreachable (fail open)', async () => {
    const hl = [audio(100, 160, 3)];
    const classify = counting(async () => { throw new Error('fetch failed'); });
    const out = await filterCombatHighlights(hl, { vod, gameName: 'God of War', classify });
    expect(out).toEqual(hl);
  });

  it('keeps a highlight on an ambiguous (null) verdict', async () => {
    const hl = [audio(100, 160, 3)];
    const out = await filterCombatHighlights(hl, { vod, gameName: 'God of War', classify: async () => null });
    expect(out).toEqual(hl);
  });

  it('returns empty input unchanged', async () => {
    expect(await filterCombatHighlights([], { vod, gameName: 'God of War' })).toEqual([]);
  });
});
