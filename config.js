export const video = {
  width: 1080,
  height: 1920,
  codec: 'libx264',
  container: 'mp4',
  maxDurationSec: 90,
  maxSizeBytes: 1024 * 1024 * 1024,
};

export const detector = {
  audioSampleRate: 8000,
  windowSec: 2,
  spikeStddevs: 2.0,
  groupGapWindows: 4,
  minClipLengthSec: 45,
  maxClipLengthSec: 90,
  preRollSec: 10,
  postRollSec: 5,
  maxHighlightsPerVod: 15,
};

export default { video, detector };
