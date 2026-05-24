// Sets a deterministic set of required env vars before any src/* module is imported.
// Most src modules transitively import src/lib/env.js which throws on missing vars,
// so test files must import this BEFORE any `await import('../../src/...')` call.
const VARS = {
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
  TWITCH_BROADCASTER_ID: '123456789',
  TWITCH_WEBHOOK_SECRET: 'test-webhook-secret',
  DISCORD_BOT_TOKEN: 'test-discord-token',
  DISCORD_CHANNEL_ID: '6590249760',
  TIKTOK_CLIENT_KEY: 'test-tiktok-key',
  TIKTOK_CLIENT_SECRET: 'test-tiktok-secret',
  TIKTOK_ACCESS_TOKEN: 'test-tiktok-access',
  LOG_LEVEL: 'silent',
};

for (const [k, v] of Object.entries(VARS)) {
  if (!process.env[k]) process.env[k] = v;
}

export const TEST_WEBHOOK_SECRET = VARS.TWITCH_WEBHOOK_SECRET;
export const TEST_CHANNEL_ID = VARS.DISCORD_CHANNEL_ID;
export const TEST_BROADCASTER_ID = VARS.TWITCH_BROADCASTER_ID;
