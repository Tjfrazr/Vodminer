import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import express from 'express';
import { TEST_WEBHOOK_SECRET } from '../__fixtures__/setEnv.js';
import {
  streamOfflineNotification,
  verificationChallenge,
} from '../__fixtures__/twitchStreamOffline.js';

const { createEventSubRouter } = await import('../../src/twitch/eventSub.js');

function signedHeaders(body, { secret = TEST_WEBHOOK_SECRET, id, timestamp, type } = {}) {
  const messageId = id ?? '11111111-2222-3333-4444-555555555555';
  const ts = timestamp ?? new Date().toISOString();
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(messageId);
  hmac.update(ts);
  hmac.update(body);
  const sig = `sha256=${hmac.digest('hex')}`;
  return {
    'twitch-eventsub-message-id': messageId,
    'twitch-eventsub-message-timestamp': ts,
    'twitch-eventsub-message-signature': sig,
    'twitch-eventsub-message-type': type ?? 'notification',
    'content-type': 'application/json',
  };
}

// Minimal in-process HTTP helper: spin up the express app, fire a request,
// capture status + body. Avoids supertest dependency.
function inject(app, { headers, body }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}/eventsub/webhook`, {
        method: 'POST',
        headers,
        body,
      })
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function buildApp() {
  const { router, emitter } = createEventSubRouter();
  const app = express();
  app.use('/eventsub', router);
  return { app, emitter };
}

describe('twitch/eventSub', () => {
  it('rejects requests with a tampered body (signature mismatch)', async () => {
    const { app } = buildApp();
    const body = Buffer.from(JSON.stringify(streamOfflineNotification));
    const headers = signedHeaders(body);
    const tampered = Buffer.from(JSON.stringify({ ...streamOfflineNotification, extra: 'mutated' }));
    const res = await inject(app, { headers, body: tampered });
    expect(res.status).toBe(403);
  });

  it('accepts a webhook_callback_verification and echoes the challenge as plain text', async () => {
    const { app } = buildApp();
    const body = Buffer.from(JSON.stringify(verificationChallenge));
    const headers = signedHeaders(body, { type: 'webhook_callback_verification' });
    const res = await inject(app, { headers, body });
    expect(res.status).toBe(200);
    expect(res.body).toBe(verificationChallenge.challenge);
  });

  it('emits stream.offline with broadcasterId for a valid notification', async () => {
    const { app, emitter } = buildApp();
    const body = Buffer.from(JSON.stringify(streamOfflineNotification));
    const headers = signedHeaders(body, { type: 'notification' });

    const received = new Promise((resolve) => emitter.once('stream.offline', resolve));
    const res = await inject(app, { headers, body });
    expect(res.status).toBe(200);

    const evt = await received;
    expect(evt.broadcasterId).toBe(streamOfflineNotification.event.broadcaster_user_id);
    expect(evt.broadcasterUserName).toBe(streamOfflineNotification.event.broadcaster_user_name);
  });

  it('rejects requests whose timestamp is older than 10 minutes', async () => {
    const { app } = buildApp();
    const body = Buffer.from(JSON.stringify(streamOfflineNotification));
    const oldTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const headers = signedHeaders(body, { timestamp: oldTs });
    const res = await inject(app, { headers, body });
    expect(res.status).toBe(403);
  });

  it('rejects requests with missing signature headers', async () => {
    const { app } = buildApp();
    const body = Buffer.from(JSON.stringify(streamOfflineNotification));
    const headers = {
      'twitch-eventsub-message-type': 'notification',
      'content-type': 'application/json',
    };
    const res = await inject(app, { headers, body });
    expect(res.status).toBe(403);
  });

  it('returns 200 (no emit) for a revocation message', async () => {
    const { app, emitter } = buildApp();
    const body = Buffer.from(JSON.stringify({ subscription: { type: 'stream.offline', status: 'authorization_revoked' } }));
    const headers = signedHeaders(body, { type: 'revocation' });

    let emitted = false;
    emitter.on('stream.offline', () => {
      emitted = true;
    });

    const res = await inject(app, { headers, body });
    expect(res.status).toBe(200);
    expect(emitted).toBe(false);
  });
});
