import '../__fixtures__/setEnv.js';
import { categorizeTacticalHighlights, isTacticalShooterGame } from '../../src/detectors/tacticalFilter.js';

const vod = { vodId: 'v1', url: 'https://www.twitch.tv/videos/v1', durationSec: 3600 };
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });

describe('isTacticalShooterGame', () => {
  it('matches known tactical shooters regardless of case or subtitle', () => {
    expect(isTacticalShooterGame('Ready or Not')).toBe(true);
    expect(isTacticalShooterGame('READY OR NOT')).toBe(true);
    expect(isTacticalShooterGame('SWAT 4')).toBe(true);
    expect(isTacticalShooterGame('Ground Branch')).toBe(true);
    expect(isTacticalShooterGame("Tom Clancy's Rainbow Six Siege")).toBe(true);
    expect(isTacticalShooterGame('Insurgency: Sandstorm')).toBe(true);
  });

  it('does not match non-tactical games (including generic FPS)', () => {
    expect(isTacticalShooterGame('God of War')).toBe(false);
    expect(isTacticalShooterGame('Forza Horizon 5')).toBe(false);
    expect(isTacticalShooterGame('Call of Duty: Modern Warfare III')).toBe(false);
    expect(isTacticalShooterGame('VALORANT')).toBe(false);
    expect(isTacticalShooterGame('Stardew Valley')).toBe(false);
  });

  it('returns false for missing game name', () => {
    expect(isTacticalShooterGame(null)).toBe(false);
    expect(isTacticalShooterGame('')).toBe(false);
    expect(isTacticalShooterGame(undefined)).toBe(false);
  });
});

describe('categorizeTacticalHighlights', () => {
  const counting = (impl) => {
    const fn = async (...args) => { fn.calls += 1; return impl(...args); };
    fn.calls = 0;
    return fn;
  };

  it('passes non-tactical games through without categorizing', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => 'BREACH');
    const out = await categorizeTacticalHighlights(hl, { vod, gameName: 'God of War', categorize });
    expect(out).toEqual(hl);
    expect(categorize.calls).toBe(0);
  });

  it('never drops a highlight — only labels or leaves it unlabeled', async () => {
    const breach = audio(100, 160, 3);
    const unmatched = audio(500, 560, 2);
    const categorize = counting(async (h) => (h.startSec === 100 ? 'BREACH' : null));
    const out = await categorizeTacticalHighlights([breach, unmatched], { vod, gameName: 'Ready or Not', categorize });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startSec: 100, category: 'BREACH' });
    expect(out[1]).toEqual(unmatched); // no category field added when null
  });

  it('categorizes viewer clips too (unlike combatFilter, nothing is exempt)', async () => {
    const human = viewer(100, 160, 999);
    const categorize = counting(async () => 'FIREFIGHT');
    const out = await categorizeTacticalHighlights([human], { vod, gameName: 'Ready or Not', categorize });
    expect(categorize.calls).toBe(1);
    expect(out[0].category).toBe('FIREFIGHT');
  });

  it('keeps a highlight unlabeled when categorize throws (fail open)', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => { throw new Error('ollama unreachable'); });
    const out = await categorizeTacticalHighlights(hl, { vod, gameName: 'Ready or Not', categorize });
    expect(out).toEqual(hl);
  });

  it('returns empty input unchanged', async () => {
    expect(await categorizeTacticalHighlights([], { vod, gameName: 'Ready or Not' })).toEqual([]);
  });
});
