import { Client, GatewayIntentBits } from 'discord.js';
import { env } from '../src/lib/env.js';

async function main() {
  console.log('--- L3: Discord connection test ---\n');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  console.log('[1/3] Logging in bot...');
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(env.DISCORD_BOT_TOKEN).catch(reject);
  });
  console.log(`      OK. Logged in as ${client.user.tag}\n`);

  console.log(`[2/3] Fetching channel ${env.DISCORD_CHANNEL_ID}...`);
  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`channel ${env.DISCORD_CHANNEL_ID} is not a text channel`);
  }
  console.log(`      OK. Channel: #${channel.name ?? '(unnamed)'} in guild ${channel.guild?.name ?? '(unknown)'}\n`);

  console.log('[3/3] Sending test message...');
  const message = await channel.send(
    'Vodminer L3 test — bot is connected and can post in this channel. ' +
    `(${new Date().toISOString()})`,
  );
  console.log(`      OK. Message posted: ${message.url}\n`);

  console.log('L3 passed. Discord bot token, channel id, and permissions are all valid.');
  await client.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nL3 FAILED:', err.message);
  if (err.message?.includes('TOKEN_INVALID')) {
    console.error('  -> DISCORD_BOT_TOKEN is wrong or has been rotated.');
  } else if (err.message?.includes('Unknown Channel') || err.message?.includes('Missing Access')) {
    console.error('  -> DISCORD_CHANNEL_ID is wrong, or the bot is not in the server, or it lacks View Channel / Send Messages.');
  }
  process.exit(1);
});
