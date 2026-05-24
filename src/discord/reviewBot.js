import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const DISCORD_FREE_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

const emitter = new EventEmitter();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let channel = null;
let ready = false;
let startPromise = null;

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, clipId] = interaction.customId.split(':');
  if (!clipId || (action !== 'approve' && action !== 'reject')) return;

  try {
    await interaction.deferUpdate();
  } catch (err) {
    logger.warn({ err, clipId }, 'discord: deferUpdate failed');
    return;
  }

  const decidedBy = interaction.user?.tag ?? 'unknown';
  const hhmm = new Date().toISOString().slice(11, 16);
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const footer = `${verb} by ${decidedBy} at ${hhmm} UTC`;

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${clipId}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`reject:${clipId}`)
      .setLabel('Reject')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
  );

  const originalContent = interaction.message?.content ?? '';
  const newContent = originalContent
    ? `${originalContent}\n${footer}`
    : footer;

  try {
    await interaction.editReply({ content: newContent, components: [disabledRow] });
  } catch (err) {
    logger.warn({ err, clipId }, 'discord: editReply failed');
  }

  logger.info({ clipId, action, decidedBy }, 'discord: review decision');
  emitter.emit(action === 'approve' ? 'approved' : 'rejected', clipId);
});

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
    .setTitle(`Clip ${clip.id}`)
    .setDescription('Approve or reject this clip for TikTok.')
    .addFields(
      { name: 'Source VOD', value: String(clip.sourceVodId), inline: true },
      { name: 'Duration', value: `${clip.durationSec}s`, inline: true },
      { name: 'Created', value: clip.createdAt, inline: false },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${clip.id}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject:${clip.id}`)
      .setLabel('Reject')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );

  let size = 0;
  try {
    const s = await stat(clip.filePath);
    size = s.size;
  } catch (err) {
    logger.warn({ err, clipId: clip.id, filePath: clip.filePath }, 'discord: stat failed, sending text-only preview');
  }

  const payload = { embeds: [embed], components: [row] };

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
    status: 'pending',
  };
}

function on(event, listener) {
  emitter.on(event, listener);
  return reviewBot;
}

function off(event, listener) {
  emitter.off(event, listener);
  return reviewBot;
}

async function stop() {
  if (!ready) return;
  await client.destroy();
  ready = false;
  channel = null;
  startPromise = null;
}

const reviewBot = { start, sendPreview, on, off, stop };

export { start, sendPreview, on, off, stop };
export default reviewBot;
