import { fetch } from 'undici';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const SCOPES = 'video.publish,video.upload,user.info.basic';

const tokenCache = {
  accessToken: env.TIKTOK_ACCESS_TOKEN || '',
  refreshToken: '',
  expiresAt: 0,
};

if (tokenCache.accessToken) {
  // WHY: env-provided token has no known expiry; assume valid for 23h from process start.
  tokenCache.expiresAt = Date.now() + 23 * 60 * 60 * 1000;
}

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    scope: SCOPES,
    response_type: 'code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI || 'http://localhost:3000/tiktok/callback',
    state: state || '',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI || 'http://localhost:3000/tiktok/callback',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.refreshToken = data.refresh_token || '';
  tokenCache.expiresAt = Date.now() + Number(data.expires_in || 0) * 1000;
  logger.info({ scope: data.scope }, 'TikTok token acquired');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    scope: data.scope,
  };
}

async function refreshAccessToken() {
  if (!tokenCache.refreshToken) {
    throw new Error('No TikTok refresh token available. Run the auth bootstrap: visit getAuthUrl() and call exchangeCodeForToken(code).');
  }

  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokenCache.refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.refreshToken = data.refresh_token || tokenCache.refreshToken;
  tokenCache.expiresAt = Date.now() + Number(data.expires_in || 0) * 1000;
  logger.info('TikTok token refreshed');
  return tokenCache.accessToken;
}

export async function getAccessToken() {
  const now = Date.now();
  // WHY: refresh 60s before expiry to avoid races with in-flight requests.
  if (tokenCache.accessToken && tokenCache.expiresAt - now > 60 * 1000) {
    return tokenCache.accessToken;
  }
  if (tokenCache.refreshToken) {
    return refreshAccessToken();
  }
  if (tokenCache.accessToken) {
    return tokenCache.accessToken;
  }
  throw new Error('No TikTok access token. Run the auth bootstrap: visit getAuthUrl() and call exchangeCodeForToken(code).');
}

export default getAccessToken;
