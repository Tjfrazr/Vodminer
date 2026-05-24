import { jest } from '@jest/globals';
import '../__fixtures__/setEnv.js';
import { tiktokTokenResponse } from '../__fixtures__/tiktokResponses.js';

const fetchMock = jest.fn();
jest.unstable_mockModule('undici', () => ({
  fetch: fetchMock,
}));

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('tiktok/auth', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    jest.resetModules();
    jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));
  });

  it('getAuthUrl includes client_key, scope, response_type=code, and the state param', async () => {
    const { getAuthUrl } = await import('../../src/tiktok/auth.js');
    const url = getAuthUrl('xyz-state');
    expect(url).toContain('client_key=test-tiktok-key');
    expect(url).toContain('response_type=code');
    expect(url).toMatch(/scope=video\.publish/);
    expect(url).toContain('state=xyz-state');
  });

  it('exchangeCodeForToken POSTs to the token endpoint and caches the result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tiktokTokenResponse));
    const { exchangeCodeForToken, getAccessToken } = await import('../../src/tiktok/auth.js');

    const out = await exchangeCodeForToken('auth-code-123');
    expect(out.access_token).toBe(tiktokTokenResponse.access_token);
    expect(out.refresh_token).toBe(tiktokTokenResponse.refresh_token);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('open.tiktokapis.com/v2/oauth/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(opts.body)).toContain('grant_type=authorization_code');
    expect(String(opts.body)).toContain('code=auth-code-123');

    // Subsequent call should use the cached token (no extra fetch).
    const tok = await getAccessToken();
    expect(tok).toBe(tiktokTokenResponse.access_token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exchangeCodeForToken throws on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }));
    const { exchangeCodeForToken } = await import('../../src/tiktok/auth.js');
    await expect(exchangeCodeForToken('bad-code')).rejects.toThrow(/TikTok token exchange failed: 400/);
  });

  it('getAccessToken returns the env-provided token when no exchange has happened', async () => {
    // Module cold-start: TIKTOK_ACCESS_TOKEN is in env (from setEnv.js), so auth.js
    // seeds it into tokenCache and getAccessToken returns it directly.
    const { getAccessToken } = await import('../../src/tiktok/auth.js');
    const tok = await getAccessToken();
    expect(tok).toBe(process.env.TIKTOK_ACCESS_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
