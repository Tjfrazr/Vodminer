import audioDetector from './audioDetector.js';
import viewerClipDetector from './viewerClipDetector.js';
import motionDetector from './motionDetector.js';
import { logger } from '../lib/logger.js';

// The detector registry. Adding a new highlight source = write a
// { name, detect(vod) => Promise<Highlight[]> } module and push it here.
export const detectors = [audioDetector, viewerClipDetector, motionDetector];

// Run detectors sequentially (they spawn heavy yt-dlp/ffmpeg processes — running
// them concurrently would double peak resource use). One failing never kills the
// others. Returns per-detector results so the pipeline can log counts.
// onProgress (optional) is awaited before/after each detector, so callers can
// post a live status update (e.g. to Discord) without racing detector order.
export async function runDetectors(vod, list = detectors, { onProgress } = {}) {
  const results = [];
  for (const d of list) {
    const startedAt = Date.now();
    await onProgress?.({ name: d.name, phase: 'start' });
    try {
      const highlights = (await d.detect(vod)) ?? [];
      results.push({ name: d.name, highlights });
      await onProgress?.({ name: d.name, phase: 'done', count: highlights.length, tookMs: Date.now() - startedAt });
    } catch (err) {
      logger.warn({ err: err?.message, detector: d.name, vodId: vod?.vodId }, 'detector.failed');
      results.push({ name: d.name, highlights: [], error: err?.message ?? 'unknown error' });
      await onProgress?.({ name: d.name, phase: 'failed', error: err?.message ?? 'unknown error', tookMs: Date.now() - startedAt });
    }
  }
  return results;
}
