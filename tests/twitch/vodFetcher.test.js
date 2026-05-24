import { jest } from '@jest/globals';
import '../__fixtures__/setEnv.js';
import {
  helixVideosResponse,
  helixVideosEmpty,
  twitchOAuthResponse,
} from '../__fixtures__/twitchHelixVideos.js';

// Mock undici BEFORE importing the module under test. jest.unstable_mockModule
// requires this to be at the top, before any awaited import of the SUT.
const fetchMock = jest.fn();
jest.unstable_mockModule('undici', () => ({
  fetch: fetchMock,
}));

const { getAppAccessToken, getLatestVod } = await import('../../src/twitch/vodFetcher.js');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('twitch/vodFetcher', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe('getAppAccessToken', () => {
    it('fetches a token from id.twitch.tv on first call', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(twitchOAuthResponse));
      const token = await getAppAccessToken();
      expect(token).toBe(twitchOAuthResponse.access_token);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('id.twitch.tv/oauth2/token');
      expect(opts.method).toBe('POST');
    });

    it('caches the token across calls until near expiry', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(twitchOAuthResponse));
      const a = await getAppAccessToken();
      const b = await getAppAccessToken();
      const c = await getAppAccessToken();
      expect(a).toBe(b);
      expect(b).toBe(c);
      // Token cached from the previous test in the module may make this 0 — accept 0 or 1.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('throws when oauth endpoint returns non-2xx', async () => {
      // Force the cache to be considered stale by jumping the clock forward enough
      // to trigger a refresh. We can't easily reach into module state, so instead
      // we exploit that fetch is only called when the cache says refresh —
      // a fresh process-level test isolation is not feasible here without
      // jest.resetModules+re-import. Instead: assert behavior on a fresh import path.
      jest.resetModules();
      jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));
      const fresh = await import('../../src/twitch/vodFetcher.js');
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad' }, { ok: false, status: 401 }));
      await expect(fresh.getAppAccessToken()).rejects.toThrow(/twitch oauth failed/);
    });
  });

  describe('getLatestVod', () => {
    beforeEach(() => {
      // Re-isolate the module so we control the token-cache state explicitly.
      jest.resetModules();
      jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));
    });

    it('parses Helix /videos response into a typed object', async () => {
      const mod = await import('../../src/twitch/vodFetcher.js');
      fetchMock.mockResolvedValueOnce(jsonResponse(twitchOAuthResponse));
      fetchMock.mockResolvedValueOnce(jsonResponse(helixVideosResponse));

      const vod = await mod.getLatestVod('123456789');
      expect(vod).toEqual({
        vodId: helixVideosResponse.data[0].id,
        url: helixVideosResponse.data[0].url,
        durationSec: 3 * 3600 + 45 * 60 + 12,
        createdAt: helixVideosResponse.data[0].created_at,
      });

      const helixCall = fetchMock.mock.calls[1];
      expect(String(helixCall[0])).toContain('api.twitch.tv/helix/videos');
      expect(String(helixCall[0])).toContain('user_id=123456789');
      expect(String(helixCall[0])).toContain('type=archive');
      expect(helixCall[1].headers.Authorization).toBe(`Bearer ${twitchOAuthResponse.access_token}`);
      expect(helixCall[1].headers['Client-Id']).toBe('test-client-id');
    });

    it('returns null when no archives exist for the broadcaster', async () => {
      const mod = await import('../../src/twitch/vodFetcher.js');
      fetchMock.mockResolvedValueOnce(jsonResponse(twitchOAuthResponse));
      fetchMock.mockResolvedValueOnce(jsonResponse(helixVideosEmpty));

      const vod = await mod.getLatestVod('123456789');
      expect(vod).toBeNull();
    });

    it('throws when Helix returns non-2xx', async () => {
      const mod = await import('../../src/twitch/vodFetcher.js');
      fetchMock.mockResolvedValueOnce(jsonResponse(twitchOAuthResponse));
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, { ok: false, status: 403 }));
      await expect(mod.getLatestVod('123')).rejects.toThrow(/twitch helix .* failed: 403/);
    });
  });
});
