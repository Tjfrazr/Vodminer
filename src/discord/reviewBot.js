import path from 'node:path';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
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
  MessageFlags,
} from 'discord.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { deleteClip } from '../twitch/vodFetcher.js';

// Discord lowered the free-tier per-file cap from 25MB to 10MB in late 2024.
const DISCORD_FREE_ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const MANIFEST_FILE = path.resolve('clips', 'highlights-manifest.json');
const BANNED_RANGES_FILE = path.resolve('state', 'banned-ranges.json');

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
let replenishCallback = null;
const gamePendingMap = new Map(); // vodId -> { resolve, suggested }
const LOW_SCORE_THRESHOLD = 8; // clips rated below this get deleted + replaced, same as an explicit disapprove

// Shared by the disapprove flow and the low-score auto-disapprove path in the
// rate modal handler below — both mean the same thing: this clip is gone,
// its time range should never be re-suggested, and the pool should backfill
// a replacement so the VOD's clip count doesn't just shrink.
//
// Idempotency guard: a duplicate modal submission (e.g. a user retrying
// after Discord showed a client-side interaction-timeout error while this
// was still running from the first submit) must not re-run this — each run
// bans the range again and triggers another replenish, silently stacking up
// extra replacement clips for one rating action.
async function deleteAndReplenish(manifest, clip, { reason } = {}) {
  if (clip.disapproved) {
    logger.info({ clipId: clip.clipId, vodId: clip.vodId }, 'discord: clip already deleted, skipping duplicate replenish');
    return;
  }
  clip.disapproved = true;
  clip.disapprovedAt = new Date().toISOString();
  clip.disapproveReason = reason;
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  await mkdir(path.dirname(BANNED_RANGES_FILE), { recursive: true });
  let banned;
  try { banned = JSON.parse(await readFile(BANNED_RANGES_FILE, 'utf8')); } catch { banned = { banned: [] }; }
  banned.banned.push({
    vodId: clip.vodId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    disapprovedAt: clip.disapprovedAt,
    reason,
  });
  await writeFile(BANNED_RANGES_FILE, JSON.stringify(banned, null, 2) + '\n', 'utf8');
  logger.info(
    { clipId: clip.clipId, vodId: clip.vodId, startSec: clip.startSec, endSec: clip.endSec, reason },
    'discord: clip deleted, range banned',
  );

  if (clip.twitchClipUrl?.includes('clips.twitch.tv/')) {
    const slug = clip.twitchClipUrl.split('clips.twitch.tv/')[1];
    await deleteClip(slug).catch((err) => logger.warn({ err: err?.message, slug }, 'discord: twitch deleteClip error'));
  }

  if (replenishCallback) {
    await replenishCallback(clip.vodId).catch((err) =>
      logger.warn({ err: err?.message, vodId: clip.vodId }, 'discord: replenish callback failed'),
    );
  }
}

client.on('error', (err) => {
  logger.error({ err }, 'discord: client error');
});

client.on('shardDisconnect', (event) => {
  logger.warn({ event }, 'discord: shard disconnected');
});

client.on('interactionCreate', async (interaction) => {
  try {
  logger.info({ type: interaction.type, customId: interaction.customId ?? null, id: interaction.id }, 'discord: interaction received');
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

  // Disapprove button clicked → show reason modal
  if (interaction.isButton() && interaction.customId.startsWith('disapprove_')) {
    const clipId = interaction.customId.slice('disapprove_'.length);
    const modal = new ModalBuilder()
      .setCustomId(`disapprovemodal_${clipId}`)
      .setTitle('Disapprove clip');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why is this bad? (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('e.g. loading screen, boring lobby, wrong segment...'),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Disapprove modal submitted → mark manifest, ban range, remove buttons
  if (interaction.isModalSubmit() && interaction.customId.startsWith('disapprovemodal_')) {
    const clipId = interaction.customId.slice('disapprovemodal_'.length);
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    // Acknowledge the modal immediately so Discord doesn't show "interaction failed"
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let disapproveLine = reason ? `**Disapproved** — ${reason}` : `**Disapproved**`;
    try {
      const raw = await readFile(MANIFEST_FILE, 'utf8');
      const manifest = JSON.parse(raw);
      const clip = manifest.clips.find((c) => c.clipId === clipId);
      if (clip) {
        await deleteAndReplenish(manifest, clip, { reason });
        // Edit the original clip message to remove buttons and show disapproval
        await interaction.message?.edit({
          content: `${interaction.message.content}\n${disapproveLine}`,
          components: [],
        }).catch((err) => logger.warn({ err: err?.message, clipId }, 'discord: disapprove message edit failed'));
      }
    } catch (err) {
      logger.warn({ err: err?.message, clipId }, 'discord: disapprove save failed');
    }
    // Delete the ephemeral "thinking" reply — the clip message itself is updated above
    await interaction.deleteReply().catch(() => {});
    return;
  }

  // Rate modal submitted → save score + reason. Below LOW_SCORE_THRESHOLD is
  // treated as an implicit disapprove: delete + ban the range + replenish,
  // same as clicking Disapprove, since asking the user to also click
  // Disapprove after already saying "this is a 3/10" is redundant.
  if (interaction.isModalSubmit() && interaction.customId.startsWith('ratemodal_')) {
    const withoutPrefix = interaction.customId.slice('ratemodal_'.length);
    const lastUnderscore = withoutPrefix.lastIndexOf('_');
    const clipId = withoutPrefix.slice(0, lastUnderscore);
    const score = Number(withoutPrefix.slice(lastUnderscore + 1));
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    const willDelete = score < LOW_SCORE_THRESHOLD;

    // A low score runs deleteAndReplenish, which can take minutes (Ollama
    // classification, ffmpeg, a Twitch publish for the replacement clip) —
    // Discord fails the interaction client-side ("Something went wrong")
    // if it isn't acknowledged within ~3s, so defer immediately, same
    // pattern as the disapprove handler below.
    if (willDelete) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let lowScoreDeleted = false;
    try {
      const raw = await readFile(MANIFEST_FILE, 'utf8');
      const manifest = JSON.parse(raw);
      const clip = manifest.clips.find((c) => c.clipId === clipId);
      if (clip) {
        clip.rating = score;
        clip.ratingReason = reason;
        clip.ratedAt = new Date().toISOString();
        if (willDelete) {
          lowScoreDeleted = true;
          await deleteAndReplenish(manifest, clip, { reason: reason ?? `rated ${score}/10` });
        } else {
          await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        }
        logger.info({ clipId, score, reason, lowScoreDeleted }, 'discord: clip rated');
      }
    } catch (err) {
      logger.warn({ err: err?.message, clipId }, 'discord: rating save failed');
    }

    const ratingLine = reason ? `**Rated ${score}/10** — ${reason}` : `**Rated ${score}/10**`;

    if (willDelete) {
      const suffix = lowScoreDeleted ? `\n**Below ${LOW_SCORE_THRESHOLD}/10 — deleted, replaced from pool** ✓` : '';
      await interaction.message?.edit({
        content: `${interaction.message.content}\n${ratingLine}${suffix}`,
        components: [],
      }).catch((err) => logger.warn({ err: err?.message, clipId }, 'discord: rating message edit failed'));
      await interaction.deleteReply().catch(() => {});
      return;
    }

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve_${clipId}`).setLabel('✅ Approve + TikTok').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`disapprove_${clipId}`).setLabel('❌ Disapprove').setStyle(ButtonStyle.Danger),
    );
    await interaction.update({
      content: `${interaction.message.content}\n${ratingLine}`,
      components: [actionRow],
    });
    return;
  }

  // Approve modal submitted → save approval, trigger TikTok
  if (interaction.isModalSubmit() && interaction.customId.startsWith('approvemodal_')) {
    const clipId = interaction.customId.slice('approvemodal_'.length);
    const score = Number(interaction.fields.getTextInputValue('score').trim());
    const reason = interaction.fields.getTextInputValue('reason').trim() || null;
    if (!Number.isInteger(score) || score < 1 || score > 10) {
      await interaction.reply({ content: 'Score must be a whole number 1–10.', flags: MessageFlags.Ephemeral }).catch(() => {});
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
          category: clipData.category ?? null,
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
  } catch (err) {
    logger.error({ err: err?.message, stack: err?.stack, id: interaction.id }, 'discord: interactionCreate error');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'An error occurred. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
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

// Discord's real per-guild attachment cap doesn't always match our local
// DISCORD_FREE_ATTACHMENT_LIMIT estimate (boost tier, CDN-side limits, etc.),
// so a file that passes our size check can still get rejected with
// "Request entity too large". Rather than losing the whole review message
// (and the clip becoming unreviewable), retry once without the attachment.
async function sendWithAttachmentFallback(payload, logCtx) {
  try {
    return await channel.send(payload);
  } catch (err) {
    if (!payload.files) throw err;
    logger.warn({ err: err?.message, ...logCtx }, 'discord: attachment send failed, retrying without file');
    const { files, ...rest } = payload;
    const note = `-# (clip file could not be attached: ${err?.message ?? 'unknown error'})`;
    return channel.send({ ...rest, content: rest.content ? `${rest.content}\n${note}` : note });
  }
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
    const reason = size === 0 ? 'unreadable' : `${(size / 1024 / 1024).toFixed(1)} MB > 10 MB`;
    logger.warn({ clipId: clip.id, size, filePath: clip.filePath }, 'discord: clip too large to attach');
    payload.content = `clip too large to attach (${reason}): ${clip.filePath}`;
  }

  const message = await sendWithAttachmentFallback(payload, { clipId: clip.id });

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

async function sendClipRating({ clipId, gameName, category, startSec, score, reason, viewerClipTitle, twitchClipUrl, vodId, filePath }) {
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
  const categoryLabel = category ? ` · **${category.replaceAll('_', ' ')}**` : '';
  const content = [
    `**${gameName ?? 'Unknown game'}**${categoryLabel} — ${fmtTimestamp(startSec)}`,
    sourceLabel,
    `Auto-score: ${score} · ${reasonLabel}`,
    `-# Rate this clip (tap a number to add a comment)`,
  ].join('\n');

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_${clipId}`).setLabel('✅ Approve + TikTok').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`disapprove_${clipId}`).setLabel('❌ Disapprove').setStyle(ButtonStyle.Danger),
  );

  const payload = { content, components: [...rows, actionRow] };
  if (filePath) {
    try {
      const s = await stat(filePath);
      if (s.size > 0 && s.size <= DISCORD_FREE_ATTACHMENT_LIMIT) {
        payload.files = [new AttachmentBuilder(filePath)];
      } else {
        logger.warn({ clipId, size: s.size }, 'discord: preview clip too large to attach, sending link-only');
      }
    } catch (err) {
      logger.warn({ err: err?.message, clipId, filePath }, 'discord: preview stat failed, sending link-only');
    }
  }
  await sendWithAttachmentFallback(payload, { clipId });
}

// No timeout — waits indefinitely for the modal submit. An earlier 120s
// auto-accept-and-proceed caused wrong-game runs (combat filter keys off
// gameName, so a silent "unknown" meant it never filtered at all).
async function askGameName(vodId, suggestedGame, { previewImagePath } = {}) {
  if (!ready || !channel) throw new Error('reviewBot not started — call start() first');
  return new Promise(async (resolve) => {
    gamePendingMap.set(vodId, { resolve, suggested: suggestedGame ?? '' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gameinput_${vodId}`)
        .setLabel('✏️ Set game name')
        .setStyle(ButtonStyle.Primary),
    );
    const content = [
      `**New VOD detected — confirm the game**`,
      `VOD \`${vodId}\` · Auto-detected: **${suggestedGame ?? 'unknown'}**`,
      `Processing is paused until this is confirmed.`,
    ].join('\n');
    await sendWithAttachmentFallback(
      { content, components: [row], ...(previewImagePath ? { files: [previewImagePath] } : {}) },
      { vodId },
    );
  });
}

function onApprove(cb) {
  approveCallback = cb;
}

function onReplenish(cb) {
  replenishCallback = cb;
}

async function stop() {
  if (!ready) return;
  await client.destroy();
  ready = false;
  channel = null;
  startPromise = null;
}

const reviewBot = { start, sendPreview, sendSummary, sendClipRating, askGameName, onApprove, onReplenish, stop };

export { start, sendPreview, sendSummary, sendClipRating, askGameName, onApprove, onReplenish, stop };
export default reviewBot;
