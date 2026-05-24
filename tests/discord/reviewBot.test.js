import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import '../__fixtures__/setEnv.js';
import { sampleClip } from '../__fixtures__/tiktokResponses.js';

// Capture sent payloads here so tests can assert on them.
const sentMessages = [];

// Fake Discord channel.
const fakeChannel = {
  isTextBased: () => true,
  async send(payload) {
    sentMessages.push(payload);
    return { url: 'https://discord.com/channels/0/0/12345' };
  },
};

// Fake Discord client. Extends EventEmitter so the reviewBot's `.on('ready')`
// / `.on('interactionCreate')` wiring works. `login()` triggers 'ready' async.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = { tag: 'TestBot#0001' };
    this.channels = {
      fetch: jest.fn(async () => fakeChannel),
    };
    FakeClient._instances.push(this);
  }
  async login() {
    queueMicrotask(() => this.emit('ready'));
    return 'ok';
  }
  async destroy() {
    return undefined;
  }
}
FakeClient._instances = [];

// Capture rows the bot builds so we can assert button count.
const buttonInstances = [];

class FakeActionRowBuilder {
  constructor() { this.components = []; }
  addComponents(...comps) {
    this.components.push(...comps.flat());
    return this;
  }
}

class FakeButtonBuilder {
  constructor() {
    buttonInstances.push(this);
    this._customId = null;
    this._label = null;
    this._style = null;
    this._emoji = null;
    this._disabled = false;
  }
  setCustomId(id) { this._customId = id; return this; }
  setLabel(l) { this._label = l; return this; }
  setStyle(s) { this._style = s; return this; }
  setEmoji(e) { this._emoji = e; return this; }
  setDisabled(d) { this._disabled = d; return this; }
}

class FakeEmbedBuilder {
  constructor() { this.fields = []; }
  setTitle(t) { this.title = t; return this; }
  setDescription(d) { this.description = d; return this; }
  addFields(...f) { this.fields.push(...f.flat()); return this; }
}

class FakeAttachmentBuilder {
  constructor(p) { this.path = p; }
}

jest.unstable_mockModule('discord.js', () => ({
  Client: FakeClient,
  GatewayIntentBits: { Guilds: 1 },
  EmbedBuilder: FakeEmbedBuilder,
  AttachmentBuilder: FakeAttachmentBuilder,
  ActionRowBuilder: FakeActionRowBuilder,
  ButtonBuilder: FakeButtonBuilder,
  ButtonStyle: { Success: 3, Danger: 4 },
}));

// Mock fs/promises stat: return a small file (<25 MB) so attachment path is taken.
jest.unstable_mockModule('node:fs/promises', () => ({
  stat: jest.fn(async () => ({ size: 1024 * 1024 })),
}));

const reviewBot = await import('../../src/discord/reviewBot.js');

describe('discord/reviewBot', () => {
  beforeAll(async () => {
    await reviewBot.start();
  });

  afterAll(async () => {
    await reviewBot.stop();
  });

  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('sendPreview posts an embed with two buttons (approve, reject)', async () => {
    buttonInstances.length = 0;
    const result = await reviewBot.sendPreview(sampleClip);

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components).toHaveLength(1);
    expect(sent.components[0].components).toHaveLength(2);

    const customIds = sent.components[0].components.map((c) => c._customId);
    expect(customIds).toContain(`approve:${sampleClip.id}`);
    expect(customIds).toContain(`reject:${sampleClip.id}`);

    expect(result).toMatchObject({
      clipId: sampleClip.id,
      status: 'pending',
    });
    expect(result.previewUrl).toMatch(/^https:\/\/discord\.com\//);
  });

  it('emits "approved" when an approve button interaction is dispatched', async () => {
    // FakeClient stores every instance it constructs; the reviewBot module
    // built one at import time and start() was awaited above, so it's index 0.
    expect(FakeClient._instances.length).toBeGreaterThan(0);
    const botClient = FakeClient._instances[0];

    const seen = new Promise((resolve) => reviewBot.on('approved', resolve));

    const fakeInteraction = {
      isButton: () => true,
      customId: `approve:${sampleClip.id}`,
      user: { tag: 'Reviewer#0002' },
      message: { content: '' },
      async deferUpdate() {},
      async editReply() {},
    };
    botClient.emit('interactionCreate', fakeInteraction);

    const clipId = await seen;
    expect(clipId).toBe(sampleClip.id);
  });
});
