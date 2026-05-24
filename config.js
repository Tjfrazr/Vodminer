export const video = {
  width: 1080,
  height: 1920,
  codec: 'libx264',
  container: 'mp4',
  maxDurationSec: 60,
  maxSizeBytes: 1024 * 1024 * 1024,
};

export const detector = {
  audioSampleRate: 8000,
  windowSec: 2,
  spikeStddevs: 2.0,
  groupGapWindows: 4,
  clipLengthSec: 30,
  preRollSec: 10,
  maxHighlightsPerVod: 15,
};

export default { video, detector };
