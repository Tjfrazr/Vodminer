import { stat } from 'node:fs/promises';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const DISCORD_FREE_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let channel = null;
let ready = false;
let startPromise = null;

client.on('error', (err) => {
  logger.error({ err }, 'discord: client error');
});

client.on('shardDisconnect', (event) => {
  logger.warn({ event }, 'discord: shard disconnected');
});

async function start() {
  if (ready) return;
  if (startPromise) return startPromise;

  startPromise = new Promise((resolve, reject) => {
    client.once('ready', async () => {
      try {
        const ch = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
        if (!ch || !ch.isTextBased()) {
          throw new Error(`channel ${env.DISCORD_CHANNEL_ID} is not a text channel`);
        }
        channel = ch;
        ready = true;
        logger.info({ channelId: env.DISCORD_CHANNEL_ID, user: client.user?.tag }, 'discord: ready');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    client.login(env.DISCORD_BOT_TOKEN).catch(reject);
  });

  return startPromise;
}

async function sendPreview(clip) {
  if (!ready || !channel) {
    throw new Error('reviewBot not started — call start() first');
  }

  const embed = new EmbedBuilder()
    .setTitle(`Highlight ${clip.id}`)
    .addFields(
      { name: 'Source VOD', value: String(clip.sourceVodId), inline: true },
      { name: 'Duration', value: `${clip.durationSec}s`, inline: true },
      { name: 'Created', value: clip.createdAt, inline: false },
    );

  let size = 0;
  try {
    const s = await stat(clip.filePath);
    size = s.size;
  } catch (err) {
    logger.warn({ err, clipId: clip.id, filePath: clip.filePath }, 'discord: stat failed, sending text-only preview');
  }

  const payload = { embeds: [embed] };

  if (size > 0 && size <= DISCORD_FREE_ATTACHMENT_LIMIT) {
    payload.files = [new AttachmentBuilder(clip.filePath)];
  } else {
    const reason = size === 0 ? 'unreadable' : `${(size / 1024 / 1024).toFixed(1)} MB > 25 MB`;
    logger.warn({ clipId: clip.id, size, filePath: clip.filePath }, 'discord: clip too large to attach');
    payload.content = `clip too large to attach (${reason}): ${clip.filePath}`;
  }

  const message = await channel.send(payload);

  return {
    clipId: clip.id,
    previewUrl: message.url,
    status: 'delivered',
  };
}

async function stop() {
  if (!ready) return;
  await client.destroy();
  ready = false;
  channel = null;
  startPromise = null;
}

const reviewBot = { start, sendPreview, stop };

export { start, sendPreview, stop };
export default reviewBot;
