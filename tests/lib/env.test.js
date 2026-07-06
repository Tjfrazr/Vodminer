import { jest } from '@jest/globals';

// src/lib/env.js does `import 'dotenv/config'`, which reads the real .env
// file from disk on every fresh import. On a machine with a real .env (this
// one), that silently repopulates every var this test just deleted from
// process.env — the test's pass/fail then depends on whether a real .env
// happens to exist, not on env.js's own logic. Mock it to a no-op so the
// test is hermetic regardless of what's on disk.
jest.unstable_mockModule('dotenv/config', () => ({}));

const REQUIRED = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_BROADCASTER_ID',
  'TWITCH_WEBHOOK_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
];

function withAllEnv() {
  for (const k of REQUIRED) {
    process.env[k] = `test-${k.toLowerCase()}`;
  }
  process.env.PORT = '4242';
  process.env.LOG_LEVEL = 'silent';
}

function clearAllEnv() {
  for (const k of REQUIRED) delete process.env[k];
  delete process.env.PORT;
  delete process.env.LOG_LEVEL;
}

describe('lib/env', () => {
  const snapshot = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    clearAllEnv();
  });

  afterAll(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(snapshot)) {
      process.env[k] = v;
    }
  });

  it('throws when required vars are missing', async () => {
    await expect(import('../../src/lib/env.js')).rejects.toThrow(
      /Missing required environment variables/,
    );
  });

  it('lists every missing variable name in the error message', async () => {
    process.env.TWITCH_CLIENT_ID = 'x';
    process.env.TWITCH_CLIENT_SECRET = 'x';
    let caught;
    try {
      await import('../../src/lib/env.js');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/TWITCH_BROADCASTER_ID/);
    expect(caught.message).toMatch(/DISCORD_BOT_TOKEN/);
    expect(caught.message).not.toMatch(/TWITCH_CLIENT_ID,/);
  });

  it('treats whitespace-only values as missing', async () => {
    withAllEnv();
    process.env.TWITCH_BROADCASTER_ID = '   ';
    await expect(import('../../src/lib/env.js')).rejects.toThrow(
      /TWITCH_BROADCASTER_ID/,
    );
  });

  it('exports a frozen env object when all required vars are present', async () => {
    withAllEnv();
    const mod = await import('../../src/lib/env.js');
    expect(mod.env).toBeDefined();
    expect(Object.isFrozen(mod.env)).toBe(true);
    expect(mod.env.TWITCH_CLIENT_ID).toBe('test-twitch_client_id');
    expect(mod.env.PORT).toBe(4242);
    expect(mod.env.LOG_LEVEL).toBe('silent');
    expect(mod.default).toBe(mod.env);
  });

  it('defaults PORT to 3000 and LOG_LEVEL to info when unset', async () => {
    withAllEnv();
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
    const mod = await import('../../src/lib/env.js');
    expect(mod.env.PORT).toBe(3000);
    expect(mod.env.LOG_LEVEL).toBe('info');
  });
});
