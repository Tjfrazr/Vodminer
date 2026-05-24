import { jest } from '@jest/globals';
import path from 'node:path';
import '../__fixtures__/setEnv.js';
import { sampleHighlight } from '../__fixtures__/tiktokResponses.js';

// Build a chainable mock for fluent-ffmpeg.
const calls = {
  inputs: [],
  startTime: [],
  duration: [],
  videoCodec: [],
  audioCodec: [],
  videoFilters: [],
  outputOptions: [],
  format: [],
  save: [],
  endHandler: null,
};

function makeChain(input) {
  calls.inputs.push(input);
  const handlers = {};
  const chain = {
    setStartTime(t) { calls.startTime.push(t); return chain; },
    setDuration(d) { calls.duration.push(d); return chain; },
    videoCodec(c) { calls.videoCodec.push(c); return chain; },
    audioCodec(c) { calls.audioCodec.push(c); return chain; },
    videoFilters(f) { calls.videoFilters.push(f); return chain; },
    outputOptions(o) { calls.outputOptions.push(o); return chain; },
    format(f) { calls.format.push(f); return chain; },
    on(evt, cb) { handlers[evt] = cb; return chain; },
    save(out) {
      calls.save.push(out);
      // Fire end on the next tick so the awaited Promise resolves.
      queueMicrotask(() => {
        if (handlers.end) handlers.end();
      });
      return chain;
    },
  };
  return chain;
}

const ffmpegMock = jest.fn((input) => makeChain(input));

// ffprobe returns metadata consistent with the validation rules in ffmpegPipeline.js.
ffmpegMock.ffprobe = jest.fn((filePath, cb) => {
  // duration must be <= 60 + 0.5; resolution 1080x1920; codec h264; format mp4.
  cb(null, {
    format: { duration: '45', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      { codec_type: 'video', width: 1080, height: 1920, codec_name: 'h264', duration: '45' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });
});

jest.unstable_mockModule('fluent-ffmpeg', () => ({
  default: ffmpegMock,
}));

// Mock fs/promises stat to report a sane file size (< 1GB cap), and mkdir to noop.
jest.unstable_mockModule('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  stat: jest.fn(async () => ({ size: 5 * 1024 * 1024 })),
  // open is unused by ffmpegPipeline but keep the surface compatible.
  open: jest.fn(),
}));

const processModule = await import('../../src/processing/ffmpegPipeline.js');
const processClip = processModule.default;

describe('processing/ffmpegPipeline', () => {
  beforeEach(() => {
    calls.inputs.length = 0;
    calls.startTime.length = 0;
    calls.duration.length = 0;
    calls.videoCodec.length = 0;
    calls.audioCodec.length = 0;
    calls.videoFilters.length = 0;
    calls.outputOptions.length = 0;
    calls.format.length = 0;
    calls.save.length = 0;
    ffmpegMock.mockClear();
    ffmpegMock.ffprobe.mockClear();
  });

  it('rejects when highlight is missing or has an invalid range', async () => {
    await expect(processClip(null, '/tmp/src.mp4')).rejects.toThrow(/highlight is required/);
    await expect(processClip({ vodId: 'v', startSec: 10, endSec: 5 }, '/tmp/src.mp4')).rejects.toThrow(/invalid highlight range/);
    await expect(processClip(sampleHighlight, undefined)).rejects.toThrow(/sourceVideoPath is required/);
  });

  it('produces a Clip with output path matching <vodId>-<start>-<end>.mp4 under clips/', async () => {
    const clip = await processClip(sampleHighlight, '/tmp/source.mp4');
    expect(clip).toMatchObject({
      sourceVodId: sampleHighlight.vodId,
    });
    expect(typeof clip.id).toBe('string');
    expect(clip.filePath).toMatch(/clips[\\/]987654321-1200-1245\.mp4$/);
    expect(typeof clip.durationSec).toBe('number');
    expect(typeof clip.createdAt).toBe('string');
    expect(path.basename(calls.save[0])).toBe('987654321-1200-1245.mp4');
  });

  it('applies a 9:16 (1080x1920) crop/pad filter chain', async () => {
    await processClip(sampleHighlight, '/tmp/source.mp4');
    expect(calls.videoFilters).toHaveLength(1);
    const chain = calls.videoFilters[0];
    expect(chain).toContain('crop=1080:1920');
    expect(chain).toContain('pad=1080:1920');
    expect(chain).toContain('setsar=1');
  });

  it('clamps duration to <= 60s even when highlight span is longer', async () => {
    const long = { ...sampleHighlight, startSec: 100, endSec: 300 };
    await processClip(long, '/tmp/source.mp4');
    expect(calls.duration[0]).toBeLessThanOrEqual(60);
  });

  it('passes the highlight startSec to ffmpeg setStartTime', async () => {
    await processClip(sampleHighlight, '/tmp/source.mp4');
    expect(calls.startTime[0]).toBe(sampleHighlight.startSec);
  });

  it('selects h264 codec and mp4 container', async () => {
    await processClip(sampleHighlight, '/tmp/source.mp4');
    expect(calls.videoCodec[0]).toBe('libx264');
    expect(calls.format[0]).toBe('mp4');
  });

  it('includes a drawtext filter for each caption supplied', async () => {
    const captions = [
      { text: 'Pog moment', startSec: 1200, endSec: 1205 },
      { text: 'GG', startSec: 1240, endSec: 1245 },
    ];
    await processClip(sampleHighlight, '/tmp/source.mp4', captions);
    const chain = calls.videoFilters[0];
    expect(chain.match(/drawtext=/g)).toHaveLength(2);
    expect(chain).toContain('Pog moment');
    expect(chain).toContain('GG');
  });
});
