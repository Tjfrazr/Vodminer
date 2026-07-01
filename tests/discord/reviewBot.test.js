import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import '../__fixtures__/setEnv.js';
import { sampleClip } from '../__fixtures__/samples.js';

const sentMessages = [];

const fakeChannel = {
  isTextBased: () => true,
  async send(payload) {
    sentMessages.push(payload);
    return { url: 'https://discord.com/channels/0/0/12345' };
  },
};

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

class FakeEmbedBuilder {
  constructor() { this.fields = []; }
  setTitle(t) { this.title = t; return this; }
  setDescription(d) { this.description = d; return this; }
  addFields(...f) { this.fields.push(...f.flat()); return this; }
}

class FakeAttachmentBuilder {
  constructor(p) { this.path = p; }
}

// Generic chainable stand-in for the button/modal/text-input builders.
class FakeBuilder {
  setCustomId() { return this; }
  setLabel() { return this; }
  setStyle() { return this; }
  setTitle() { return this; }
  setPlaceholder() { return this; }
  setRequired() { return this; }
  setValue() { return this; }
  setMinLength() { return this; }
  setMaxLength() { return this; }
  addComponents() { return this; }
}

jest.unstable_mockModule('discord.js', () => ({
  Client: FakeClient,
  GatewayIntentBits: { Guilds: 1 },
  EmbedBuilder: FakeEmbedBuilder,
  AttachmentBuilder: FakeAttachmentBuilder,
  ActionRowBuilder: FakeBuilder,
  ButtonBuilder: FakeBuilder,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ModalBuilder: FakeBuilder,
  TextInputBuilder: FakeBuilder,
  TextInputStyle: { Short: 1, Paragraph: 2 },
  MessageFlags: { Ephemeral: 64 },
}));

jest.unstable_mockModule('node:fs/promises', () => ({
  stat: jest.fn(async () => ({ size: 1024 * 1024 })),
  readFile: jest.fn(async () => '{}'),
  writeFile: jest.fn(async () => undefined),
  mkdir: jest.fn(async () => undefined),
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

  it('sendPreview posts an embed with the clip attached and no buttons', async () => {
    const result = await reviewBot.sendPreview(sampleClip);

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0];
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components).toBeUndefined();
    expect(sent.files).toHaveLength(1);
    expect(sent.files[0]).toBeInstanceOf(FakeAttachmentBuilder);
    expect(sent.files[0].path).toBe(sampleClip.filePath);

    expect(result).toMatchObject({
      clipId: sampleClip.id,
      status: 'delivered',
    });
    expect(result.previewUrl).toMatch(/^https:\/\/discord\.com\//);
  });
});
