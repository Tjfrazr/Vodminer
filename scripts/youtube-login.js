import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import '../src/lib/env.js'; // side effect: loads dotenv

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = 4390;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const ENV_PATH = path.resolve('.env');

async function saveRefreshToken(token) {
  let content = '';
  try {
    content = await readFile(ENV_PATH, 'utf8');
  } catch {
    // no .env yet — start fresh
  }
  if (/^YOUTUBE_REFRESH_TOKEN=/m.test(content)) {
    content = content.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, `YOUTUBE_REFRESH_TOKEN=${token}`);
  } else {
    content = content.replace(/\n?$/, '\n') + `YOUTUBE_REFRESH_TOKEN=${token}\n`;
  }
  await writeFile(ENV_PATH, content, 'utf8');
}

async function main() {
  console.log('--- YouTube login (captures a refresh token for uploads) ---\n');

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env — run the Google Cloud OAuth setup first.');
    process.exit(1);
  }

  const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('Open this URL and log in with the Google account that owns the');
  console.log('destination YouTube channel (this can be a different account than');
  console.log('the one that owns the Google Cloud project):\n');
  console.log(authUrl + '\n');
  console.log(`[waiting] Listening on ${REDIRECT_URI} for the redirect...\n`);

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error) {
        res.end(`Login failed: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(error));
        return;
      }
      if (!code) {
        res.end('Waiting for authorization...');
        return;
      }

      res.end('Login successful — you can close this tab and return to the terminal.');
      server.close();

      try {
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
          reject(
            new Error(
              'No refresh_token returned — the account likely already granted consent before. ' +
                'Revoke access at https://myaccount.google.com/permissions for this app and re-run this script.',
            ),
          );
          return;
        }
        await saveRefreshToken(tokens.refresh_token);
        console.log('Refresh token captured and saved to .env as YOUTUBE_REFRESH_TOKEN.');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error('\nyoutube-login failed:', err.message);
  process.exit(1);
});
