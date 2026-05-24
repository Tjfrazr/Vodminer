import { fetch } from 'undici';
import { logger } from './logger.js';

const WEBHOOK_URL = (process.env.DISCORD_ERROR_WEBHOOK_URL || '').trim();
const ENABLED = WEBHOOK_URL.length > 0;

if (!ENABLED) {
  logger.warn('DISCORD_ERROR_WEBHOOK_URL not set — alert sink is a no-op');
}

/**
 * Send a Discord error alert. Best-effort — never throws.
 *
 * @param {'INFO'|'WARN'|'ERROR'|'FATAL'} level
 * @param {string} message
 * @param {object} [context]
 */
export async function notify(level, message, context = {}) {
  if (!ENABLED) return;

  let payloadContext;
  try {
    payloadContext = JSON.stringify(context, null, 2);
  } catch {
    payloadContext = String(context);
  }

  const content = `[${level}] ${message}\n\`\`\`json\n${payloadContext}\n\`\`\``;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'alert webhook returned non-OK status');
    }
  } catch (err) {
    logger.warn({ err: err?.message }, 'failed to post alert to Discord webhook');
  }
}

/**
 * Install process-level handlers that funnel uncaught errors to Discord.
 * Idempotent — safe to call once at startup from index.js.
 */
export function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void notify('FATAL', 'uncaughtException', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err }, 'unhandledRejection');
    void notify('FATAL', 'unhandledRejection', {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  });

  logger.info('global error handlers installed');
}

export default { notify, installGlobalHandlers };
