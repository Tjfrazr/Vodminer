import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const HEADER_ID = 'twitch-eventsub-message-id';
const HEADER_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const HEADER_SIGNATURE = 'twitch-eventsub-message-signature';
const HEADER_TYPE = 'twitch-eventsub-message-type';

const MAX_AGE_SEC = 10 * 60;

function verifySignature(req) {
  const id = req.header(HEADER_ID);
  const timestamp = req.header(HEADER_TIMESTAMP);
  const signature = req.header(HEADER_SIGNATURE);
  if (!id || !timestamp || !signature || !signature.startsWith('sha256=')) return false;

  const tsMs = Date.parse(timestamp);
  if (Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > MAX_AGE_SEC * 1000) return false;

  if (!Buffer.isBuffer(req.body)) return false;

  const hmac = crypto.createHmac('sha256', env.TWITCH_WEBHOOK_SECRET);
  hmac.update(id);
  hmac.update(timestamp);
  hmac.update(req.body);
  const expected = `sha256=${hmac.digest('hex')}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createEventSubRouter() {
  const emitter = new EventEmitter();
  const router = Router();

  router.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      if (!verifySignature(req)) {
        logger.warn({ headers: { id: req.header(HEADER_ID) } }, 'eventsub signature verification failed');
        return res.status(403).send('invalid signature');
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch (err) {
        logger.warn({ err }, 'eventsub malformed json');
        return res.status(400).send('bad json');
      }

      const messageType = req.header(HEADER_TYPE);

      if (messageType === 'webhook_callback_verification') {
        const challenge = payload?.challenge;
        if (typeof challenge !== 'string') return res.status(400).send('missing challenge');
        logger.info({ subscription: payload?.subscription?.type }, 'eventsub verification challenge accepted');
        res.set('Content-Type', 'text/plain');
        return res.status(200).send(challenge);
      }

      if (messageType === 'revocation') {
        logger.warn(
          {
            subscription: payload?.subscription?.type,
            status: payload?.subscription?.status,
          },
          'eventsub subscription revoked',
        );
        return res.status(200).send();
      }

      if (messageType === 'notification') {
        const subType = payload?.subscription?.type;
        if (subType === 'stream.offline') {
          const ev = payload?.event ?? {};
          const eventPayload = {
            broadcasterId: ev.broadcaster_user_id,
            broadcasterUserName: ev.broadcaster_user_name,
            occurredAt: payload?.subscription?.created_at ?? new Date().toISOString(),
          };
          logger.info(eventPayload, 'eventsub stream.offline received');
          emitter.emit('stream.offline', eventPayload);
          return res.status(200).send();
        }
        logger.debug({ subType }, 'eventsub notification ignored');
        return res.status(204).send();
      }

      logger.debug({ messageType }, 'eventsub unknown message type');
      return res.status(204).send();
    },
  );

  return { router, emitter };
}

export default createEventSubRouter;
