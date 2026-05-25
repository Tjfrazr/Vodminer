import path from 'node:path';
import { stat, readFile, writeFile } from 'node:fs/promises';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const DISCORD_FREE_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');

function fmtTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let channel = null;
let ready = false;
let startPromise = null;
let approveCallback = null;
const gamePendingMap = new Map(); // vodId -> { resolve, timeout }

client.on('error', (err) => {
  logger.error({ err }, 'discord: client error');
});

client.on('shardDisconnect', (event) => {
  logger.warn({ event }, 'discord: shard disconnected');
});

client.on('interactionCreate', async (interaction) => {
  // Game name button clicked → show game name modal
  if (interaction.isButton() && interaction.customId.startsWith('gameinput_')) {
    const vodId = interaction.customId.slice('gameinput_'.length);
    const pending = gamePendingMap.get(vodId);
    const current = pending?.suggested ?? '';
    const modal = new ModalBuilder()
      .setCustomId(`gamemodal_${vodId}`)
      .setTitle('Confirm game name');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('game')
          .setLabel('Game name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(current)
          .setPlaceholder('e.g. GTA V, Valorant...'),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Game name modal submitted → resolve the pipeline's waiting Promise
  if (interaction.isModalSubmit() && interaction.customId.startsWith('gamemodal_')) {
    const vodId = interaction.customId.slice('gamemodal_'.length);
    const game = interaction.fields.getTextInputValue('game').trim();
    const pending = gamePendingMap.get(vodId);
    if (pending) {
      clearTimeout(pending.timeout);
      gamePendingMap.delete(vodId);
      pending.resolve(game);
    }
    await interaction.update({
      content: `${interaction.message.content}\n**Game confirmed: ${game}** ✓`,
      components: [],
    });
    return;
  }

  // Score button clicked → show reason modal
  if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
    const parts = interaction.customId.split('_');
    const score = Number(parts[parts.length - 1]);
    const clipId = parts.slice(1, -1).join('_');
    if (!Number.isInteger(score) || score < 1 || score > 10) return;
    const modal = new ModalBuilder()
      .setCustomId(`ratemodal_${clipId}_${score}`)
      .setTitle(`Rate Clip — ${score}/10`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('e.g. great kill streak, funny moment...'),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Approve button clicked → show score + reason modal
  if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
    const clipId = interaction.customId.slice('approve_'.length);
    const modal = new ModalBuilder()
      .setCustomId(`approvemodal_${clipId}`)
      .setTitle('Approve for TikTok');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('score')
          .setLabel('Score (1-10)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setPlaceholder('8'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('why this is worth posting...'),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Rate modal submitted → save score + reason, keep Approve button
  if (interaction.isModalSubmit() && interaction.customId.startsWith('ratemodal_')) {
    const withoutPrefix = interaction.customId.slice('ratemodal_'.length);
    const lastUnderscore = withoutPrefix.lastIndexOf('_');
    const clipId = withoutPrefix.slice(0, lastUnderscore);
    const score = Number(withoutPrefix.slice(lastUnderscore + 1));
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    try {
      const raw = await readFile(MANIFEST_FILE, 'utf8');
      const manifest = JSON.parse(raw);
      const clip = manifest.clips.find((c) => c.clipId === clipId);
      if (clip) {
        clip.rating = score;
        clip.ratingReason = reason;
        clip.ratedAt = new Date().toISOString();
        await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        logger.info({ clipId, score, reason }, 'discord: clip rated');
      }
    } catch (err) {
      logger.warn({ err: err?.message, clipId }, 'discord: rating save failed');
    }
    const ratingLine = reason ? `**Rated ${score}/10** — ${reason}` : `**Rated ${score}/10**`;
    const approveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${clipId}`)
        .setLabel('✅ Approve + TikTok')
        .setStyle(ButtonStyle.Success),
    );
    await interaction.update({
      content: `${interaction.message.content}\n${ratingLine}`,
      components: [approveRow],
    });
    return;
  }

  // Approve modal submitted → save approval, trigger TikTok
  if (interaction.isModalSubmit() && interaction.customId.startsWith('approvemodal_')) {
    const clipId = interaction.customId.slice('approvemodal_'.length);
    const score = Number(interaction.fields.getTextInputValue('score').trim());
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    if (!Number.isInteger(score) || score < 1 || score > 10) {
      await interaction.reply({ content: 'Score must be a whole number 1–10.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferUpdate();
    let clipData = null;
    let tiktokStatus = 'TikTok: no handler';
    try {
      const raw = await readFile(MANIFEST_FILE, 'utf8');
      const manifest = JSON.parse(raw);
      clipData = manifest.clips.find((c) => c.clipId === clipId);
      if (clipData) {
        clipData.rating = score;
        clipData.ratingReason = reason;
        clipData.ratedAt = new Date().toISOString();
        clipData.approved = true;
        clipData.approvedAt = new Date().toISOString();
        await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        logger.info({ clipId, score, reason }, 'discord: clip approved');
      }
    } catch (err) {
      logger.warn({ err: err?.message, clipId }, 'discord: approve save failed');
    }
    if (approveCallback && clipData) {
      try {
        const result = await approveCallback({
          clipId,
          vodId: clipData.vodId,
          startSec: clipData.startSec,
          endSec: clipData.endSec,
          gameName: clipData.gameName ?? null,
          score,
          reason,
        });
        tiktokStatus = result?.sent ? 'TikTok draft sent ✓' : 'TikTok draft failed';
      } catch (err) {
        logger.warn({ err: err?.message, clipId }, 'discord: approve callback failed');
        tiktokStatus = `TikTok error: ${err?.message?.slice(0, 80)}`;
      }
    }
    const approvalLine = reason
      ? `**Approved ${score}/10** — ${reason} · ${tiktokStatus}`
      : `**Approved ${score}/10** · ${tiktokStatus}`;
    await interaction.editReply({
      content: `${interaction.message.content}\n${approvalLine}`,
      components: [],
    }).catch(() =>
      interaction.message?.edit({
        content: `${interaction.message.content}\n${approvalLine}`,
        components: [],
      }).catch(() => {}),
    );
  }
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

async function sendSummary(text) {
  if (!ready || !channel) {
    throw new Error('reviewBot not started — call start() first');
  }
  const msg = await channel.send(text.slice(0, 1900));
  return msg.url;
}

async function sendClipRating({ clipId, gameName, startSec, score, reason, viewerClipTitle, twitchClipUrl, vodId }) {
  if (!ready || !channel) throw new Error('reviewBot not started — call start() first');

  const rows = [
    new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((n) =>
        new ButtonBuilder().setCustomId(`rate_${clipId}_${n}`).setLabel(String(n)).setStyle(ButtonStyle.Secondary),
      ),
    ),
    new ActionRowBuilder().addComponents(
      [6, 7, 8, 9, 10].map((n) =>
        new ButtonBuilder().setCustomId(`rate_${clipId}_${n}`).setLabel(String(n)).setStyle(ButtonStyle.Secondary),
      ),
    ),
  ];

  const sourceLabel = twitchClipUrl ? twitchClipUrl : `VOD \`${vodId}\` @ ${fmtTimestamp(startSec)}`;
  const reasonLabel = reason === 'viewer_clip' ? `Viewer clip: "${viewerClipTitle}"` : 'Audio transient';
  const content = [
    `**${gameName ?? 'Unknown game'}** — ${fmtTimestamp(startSec)}`,
    sourceLabel,
    `Auto-score: ${score} · ${reasonLabel}`,
    `-# Rate this clip (tap a number to add a comment)`,
  ].join('\n');

  const approveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${clipId}`)
      .setLabel('✅ Approve + TikTok')
      .setStyle(ButtonStyle.Success),
  );
  await channel.send({ content, components: [...rows, approveRow] });
}

async function askGameName(vodId, suggestedGame, timeoutMs = 120000) {
  if (!ready || !channel) throw new Error('reviewBot not started — call start() first');
  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      gamePendingMap.delete(vodId);
      logger.info({ vodId, fallback: suggestedGame }, 'discord: game name timeout, using auto-detected');
      resolve(suggestedGame);
    }, timeoutMs);
    gamePendingMap.set(vodId, { resolve, timeout, suggested: suggestedGame ?? '' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gameinput_${vodId}`)
        .setLabel('✏️ Set game name')
        .setStyle(ButtonStyle.Primary),
    );
    const timeoutSec = Math.round(timeoutMs / 1000);
    const content = [
      `**New VOD detected — confirm the game**`,
      `VOD \`${vodId}\` · Auto-detected: **${suggestedGame ?? 'unknown'}**`,
      `Click to correct, or ignore to accept (${timeoutSec}s timeout).`,
    ].join('\n');
    await channel.send({ content, components: [row] });
  });
}

function onApprove(cb) {
  approveCallback = cb;
}

async function stop() {
  if (!ready) return;
  await client.destroy();
  ready = false;
  channel = null;
  startPromise = null;
}

const reviewBot = { start, sendPreview, sendSummary, sendClipRating, askGameName, onApprove, stop };

export { start, sendPreview, sendSummary, sendClipRating, askGameName, onApprove, stop };
export default reviewBot;
