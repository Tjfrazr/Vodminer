import 'dotenv/config';

const REQUIRED = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_BROADCASTER_ID',
  'TWITCH_WEBHOOK_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
];

const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export const env = Object.freeze({
  TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_ID: process.env.TWITCH_BROADCASTER_ID,
  TWITCH_WEBHOOK_SECRET: process.env.TWITCH_WEBHOOK_SECRET,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
  TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET,
  TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN || '',
  PORT: Number(process.env.PORT || 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
});

export default env;
