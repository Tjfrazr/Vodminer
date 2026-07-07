import { google } from 'googleapis';
import '../lib/env.js'; // side effect: loads dotenv

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

let client = null;

function getClient() {
  if (client) return client;
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      'Missing YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET/YOUTUBE_REFRESH_TOKEN in .env — run scripts/youtube-login.js first.',
    );
  }
  client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return client;
}

// Returns a valid (auto-refreshed) bearer access token for direct HTTP calls.
// Used by youtube/uploader.js's hand-rolled resumable upload — see that file
// for why: the googleapis package's videos.insert does a single-shot
// multipart upload, not YouTube's actual resumable protocol, despite the
// media/body option implying otherwise. google-auth-library's OAuth2Client
// (bundled with googleapis) is still the right tool for the token-refresh
// part, which is the fiddly bit worth not hand-rolling.
export async function getAccessToken() {
  const { token } = await getClient().getAccessToken();
  if (!token) throw new Error('youtube: failed to obtain access token');
  return token;
}

// Returns the underlying OAuth2Client, for callers that use the googleapis
// client directly (e.g. the small, non-resumability-sensitive thumbnail
// upload) rather than hand-rolled fetch calls.
export function getOAuth2Client() {
  return getClient();
}

export default { getAccessToken, getOAuth2Client };
