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
export async function runDetectors(vod, list = detectors) {
  const results = [];
  for (const d of list) {
    try {
      results.push({ name: d.name, highlights: (await d.detect(vod)) ?? [] });
    } catch (err) {
      logger.warn({ err: err?.message, detector: d.name, vodId: vod?.vodId }, 'detector.failed');
      results.push({ name: d.name, highlights: [], error: err?.message ?? 'unknown error' });
    }
  }
  return results;
}
