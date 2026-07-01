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
  maxHighlightsPerVod: 20,
  // Motion/scene detector (ffmpeg-native). Tuning knobs — the physical stream
  // varies (game, resolution), so leave these adjustable rather than hardcoded.
  motion: {
    sceneThreshold: 0.4, // ffmpeg scene score 0..1; higher = bigger visual cut
    fps: 2, // frames/sec analyzed (decode is downsampled — keeps it cheap)
    scaleWidth: 192, // downscale before scene calc; motion needs no detail
    ytFormat: 'worst[height>=160]/worst', // smallest usable video stream
    groupGapSec: 8, // merge scene hits closer than this into one highlight
    timeoutMs: 30 * 60 * 1000, // kill the yt-dlp|ffmpeg scan if it stalls/goes live
    // Maps scene score (0..1) onto the audio score range for cross-detector
    // ranking. Deliberately conservative: audio (proven) starts ~2.0 and runs
    // ~2-6, so scale=5 keeps motion (0.4→2.0, 1.0→5.0) comparable, NOT dominant,
    // until it's validated on a real VOD. Raise once motion recall is trusted.
    scoreScale: 5,
  },
};

export default { video, detector };
