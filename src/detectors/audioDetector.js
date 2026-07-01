import detectClips from '../twitch/clipDetector.js';

// Registry wrapper around the existing audio-transient (RMS spike) detector.
async function detect(vod) {
  return (await detectClips(vod)) ?? [];
}

export default { name: 'audioTransient', detect };
