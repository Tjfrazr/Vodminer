import { jest } from '@jest/globals';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../__fixtures__/setEnv.js';

// Mock undici BEFORE importing the module under test — same pattern as
// tests/twitch/vodFetcher.test.js.
const fetchMock = jest.fn();
jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));

const { initResumableSession, uploadChunks } = await import('../../src/youtube/uploader.js');

function res({ status = 200, headers = {}, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('youtube/uploader', () => {
  let dir, filePath;

  beforeEach(async () => {
    fetchMock.mockReset();
    dir = await mkdtemp(path.join(tmpdir(), 'uploader-test-'));
    filePath = path.join(dir, 'video.bin');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  describe('initResumableSession', () => {
    it('returns the Location header from a successful init', async () => {
      fetchMock.mockResolvedValueOnce(res({ status: 200, headers: { location: 'https://example.com/session1' } }));
      const url = await initResumableSession('token', { title: 't', description: 'd', sizeBytes: 100 }, 'https://fake/init');
      expect(url).toBe('https://example.com/session1');
    });

    it('throws when the init response has no Location header', async () => {
      fetchMock.mockResolvedValueOnce(res({ status: 200, headers: {} }));
      await expect(
        initResumableSession('token', { title: 't', description: 'd', sizeBytes: 100 }, 'https://fake/init'),
      ).rejects.toThrow(/no Location header/);
    });

    it('throws when the init request itself fails', async () => {
      fetchMock.mockResolvedValueOnce(res({ status: 403, body: 'forbidden' }));
      await expect(
        initResumableSession('token', { title: 't', description: 'd', sizeBytes: 100 }, 'https://fake/init'),
      ).rejects.toThrow(/failed to init resumable session/);
    });
  });

  describe('uploadChunks', () => {
    it('completes in a single PUT when the file fits in one chunk', async () => {
      await writeFile(filePath, Buffer.alloc(1024, 1));
      fetchMock.mockResolvedValueOnce(res({ status: 200, body: { id: 'video123' } }));

      const result = await uploadChunks('https://fake/session', filePath, 1024, async () => 'token');
      expect(result).toEqual({ id: 'video123' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Content-Range']).toBe('bytes 0-1023/1024');
    });

    it('recovers after a chunk failure by querying received bytes and resuming from there', async () => {
      await writeFile(filePath, Buffer.alloc(2048, 1));
      fetchMock
        .mockRejectedValueOnce(new Error('network blip')) // first chunk attempt fails
        .mockResolvedValueOnce(res({ status: 308, headers: { range: 'bytes=0-1023' } })) // recovery query: 1024 bytes already received
        .mockResolvedValueOnce(res({ status: 200, body: { id: 'video456' } })); // resumed chunk from offset 1024 completes

      const result = await uploadChunks('https://fake/session', filePath, 2048, async () => 'token');
      expect(result).toEqual({ id: 'video456' });
      // 3rd call is the resumed PUT -- must start at byte 1024, not 0
      const [, opts] = fetchMock.mock.calls[2];
      expect(opts.headers['Content-Range']).toBe('bytes 1024-2047/2048');
    });

    it('terminates with a thrown error on a persistently failing connection, never loops forever', async () => {
      await writeFile(filePath, Buffer.alloc(1024, 1));
      // Every PUT (chunk or recovery-query) fails the same way, forever --
      // this is the exact scenario that used to hang: `attempt` was scoped
      // inside the outer while loop and reset every iteration, making the
      // retry cap unreachable.
      fetchMock.mockResolvedValue(res({ status: 500, body: 'persistent error' }));

      await expect(uploadChunks('https://fake/session', filePath, 1024, async () => 'token')).rejects.toThrow();
      // Must terminate with a bounded number of calls, not hang/loop unboundedly.
      expect(fetchMock.mock.calls.length).toBeLessThan(100);
    }, 20000);
  });
});
