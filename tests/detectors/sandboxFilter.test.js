import '../__fixtures__/setEnv.js';
import { categorizeSandboxHighlights, isSandboxGame } from '../../src/detectors/sandboxFilter.js';

const vod = { vodId: 'v1', url: 'https://www.twitch.tv/videos/v1', durationSec: 3600 };
const audio = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'audio_transient' });
const viewer = (startSec, endSec, score) => ({ vodId: 'v1', startSec, endSec, score, reason: 'viewer_clip' });

describe('isSandboxGame', () => {
  it('matches known sandbox games regardless of case or subtitle', () => {
    expect(isSandboxGame('Grand Theft Auto V')).toBe(true);
    expect(isSandboxGame('GRAND THEFT AUTO ONLINE')).toBe(true);
    expect(isSandboxGame('GTA 5')).toBe(true);
    expect(isSandboxGame('Red Dead Redemption 2')).toBe(true);
    expect(isSandboxGame('Saints Row IV')).toBe(true);
    expect(isSandboxGame('Watch Dogs: Legion')).toBe(true);
    expect(isSandboxGame('Just Cause 4')).toBe(true);
    expect(isSandboxGame('Sleeping Dogs')).toBe(true);
    expect(isSandboxGame('Mafia: Definitive Edition')).toBe(true);
    expect(isSandboxGame('Cyberpunk 2077')).toBe(true);
  });

  it('does not match games from the other genre filters', () => {
    expect(isSandboxGame('God of War')).toBe(false);
    expect(isSandboxGame('Forza Horizon 5')).toBe(false);
    expect(isSandboxGame('Ready or Not')).toBe(false);
    expect(isSandboxGame('Elden Ring')).toBe(false);
    expect(isSandboxGame('Need for Speed Heat')).toBe(false);
  });

  it('does not match open-world games of a different genre', () => {
    expect(isSandboxGame('The Elder Scrolls V: Skyrim')).toBe(false);
    expect(isSandboxGame('The Witcher 3: Wild Hunt')).toBe(false);
    expect(isSandboxGame('Minecraft')).toBe(false);
    expect(isSandboxGame('Stardew Valley')).toBe(false);
  });

  it('returns false for missing game name', () => {
    expect(isSandboxGame(null)).toBe(false);
    expect(isSandboxGame('')).toBe(false);
    expect(isSandboxGame(undefined)).toBe(false);
  });
});

describe('categorizeSandboxHighlights', () => {
  const counting = (impl) => {
    const fn = async (...args) => { fn.calls += 1; return impl(...args); };
    fn.calls = 0;
    return fn;
  };

  it('passes non-sandbox games through without categorizing', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => 'POLICE_CHASE');
    const out = await categorizeSandboxHighlights(hl, { vod, gameName: 'Forza Horizon 5', categorize });
    expect(out).toEqual(hl);
    expect(categorize.calls).toBe(0);
  });

  it('never drops a highlight — only labels or leaves it unlabeled', async () => {
    const chase = audio(100, 160, 3);
    const unmatched = audio(500, 560, 2);
    const categorize = counting(async (h) => (h.startSec === 100 ? 'POLICE_CHASE' : null));
    const out = await categorizeSandboxHighlights([chase, unmatched], { vod, gameName: 'Grand Theft Auto V', categorize });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startSec: 100, category: 'POLICE_CHASE' });
    expect(out[1]).toEqual(unmatched); // no category field added when null
  });

  it('categorizes viewer clips too (unlike combatFilter, nothing is exempt)', async () => {
    const human = viewer(100, 160, 999);
    const categorize = counting(async () => 'EXPLOSION');
    const out = await categorizeSandboxHighlights([human], { vod, gameName: 'GTA Online', categorize });
    expect(categorize.calls).toBe(1);
    expect(out[0].category).toBe('EXPLOSION');
  });

  it('keeps a highlight unlabeled when categorize throws (fail open)', async () => {
    const hl = [audio(100, 160, 3)];
    const categorize = counting(async () => { throw new Error('ollama unreachable'); });
    const out = await categorizeSandboxHighlights(hl, { vod, gameName: 'Red Dead Redemption 2', categorize });
    expect(out).toEqual(hl);
  });

  it('returns empty input unchanged', async () => {
    expect(await categorizeSandboxHighlights([], { vod, gameName: 'Grand Theft Auto V' })).toEqual([]);
  });
});
