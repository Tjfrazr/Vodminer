// Realistic shape of a Twitch EventSub `stream.offline` notification body.
// Sourced from Twitch EventSub docs (subscription types reference). Field names
// match Helix conventions: snake_case, broadcaster_user_* triplet.
// FLAG-FOR-REVIEW: `subscription.condition` and `created_at` formats are best-effort
// guesses against published examples — verify against a live webhook capture.
export const streamOfflineNotification = {
  subscription: {
    id: 'f1c2a4b0-9b1f-4c3d-9b2c-4a9c1f8e1234',
    type: 'stream.offline',
    version: '1',
    status: 'enabled',
    cost: 0,
    condition: { broadcaster_user_id: '123456789' },
    transport: {
      method: 'webhook',
      callback: 'https://example.com/eventsub/webhook',
    },
    created_at: '2026-05-24T18:00:00.000Z',
  },
  event: {
    broadcaster_user_id: '123456789',
    broadcaster_user_login: 'tjstreams',
    broadcaster_user_name: 'TJStreams',
  },
};

export const verificationChallenge = {
  challenge: 'pogchamp-test-challenge-string',
  subscription: {
    id: 'f1c2a4b0-9b1f-4c3d-9b2c-4a9c1f8e1234',
    type: 'stream.offline',
    version: '1',
    status: 'webhook_callback_verification_pending',
    cost: 0,
    condition: { broadcaster_user_id: '123456789' },
    transport: {
      method: 'webhook',
      callback: 'https://example.com/eventsub/webhook',
    },
    created_at: '2026-05-24T18:00:00.000Z',
  },
};
