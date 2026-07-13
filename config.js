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
  // Wall-clock kill switch for the audio extract (same guard class as
  // motion.timeoutMs) — a stalled HLS read must fail loudly, never hang.
  audioTimeoutMs: 30 * 60 * 1000,
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
  // Vision combat filter (src/detectors/combatFilter.js). The signal detectors
  // above are content-blind — an amplitude spike from a menu click looks the
  // same as a sword clash. For action/fighting games, after mergeHighlights,
  // sample a few frames from each candidate window and ask a local Ollama
  // vision model whether they show active combat; drop menu/cutscene/idle
  // candidates before the expensive preview render + Discord review. Runs
  // fully locally — no API key, no cost, nothing leaves the machine. No-ops
  // (keeps everything) when Ollama isn't reachable, the game doesn't match
  // actionGameKeywords, or anything in the classify path errors — it must
  // never lose a real highlight or crash the pipeline.
  combatFilter: {
    enabled: true,
    ollamaHost: 'http://localhost:11434',
    // gemma3:4b chosen after live testing against real VOD frames: moondream
    // and llava:13b both answered "combat" on every frame including an
    // unambiguous weapons-menu screenshot; gemma3:4b correctly discriminated
    // menu/climbing/puzzle frames from ones with a visible enemy once asked a
    // direct yes/no question instead of a category list (see combatFilter.js
    // header comment). `ollama pull gemma3:4b` on the runtime machine first.
    model: 'gemma3:4b',
    framesPerHighlight: 3, // sampled evenly inside the candidate window
    frameWidth: 640, // downscale before base64 — plenty for "is this combat"
    frameTimeoutMs: 60 * 1000, // per-frame ffmpeg kill switch (same guard class as motion.timeoutMs)
    ytFormat: 'best[height<=480]/best', // higher than motion's 160p — semantics need some detail
    // Case-insensitive substring match against the confirmed game name. Only
    // games matching one of these get combat-filtered; everything else (racing,
    // strategy, visual novels, ...) passes through untouched. Add entries as
    // new action/fighting games show up on stream.
    actionGameKeywords: [
      'god of war',
      'devil may cry',
      'elden ring',
      'dark souls',
      'sekiro',
      'bloodborne',
      'lies of p',
      'black myth',
      'nioh',
      'ninja gaiden',
      'bayonetta',
      'metal gear rising',
      'nier',
      'stellar blade',
      'ghost of tsushima',
      'ghost of yotei',
      'monster hunter',
      'hades',
      'doom',
      'street fighter',
      'mortal kombat',
      'tekken',
      'guilty gear',
      'smash bros',
      'dragon ball fighterz',
    ],
  },
  // Racing-category labeler (src/detectors/racingFilter.js). Same local-Ollama
  // mechanism as combatFilter, but LABELS candidates with a category (crash,
  // drift, overtake, ...) instead of dropping them — these prompts are
  // unvalidated against real Forza footage, so this is deliberately
  // fail-open/non-destructive until there's real footage to tune against.
  racingFilter: {
    enabled: true,
    ollamaHost: 'http://localhost:11434',
    model: 'gemma3:4b', // same model as combatFilter; re-evaluate once tested on real racing frames
    framesPerHighlight: 3,
    frameWidth: 640,
    frameTimeoutMs: 60 * 1000,
    ytFormat: 'best[height<=480]/best',
    racingGameKeywords: [
      'forza',
      'gran turismo',
      'need for speed',
      'f1 2',
      'f1 twenty',
      'dirt rally',
      'dirt 5',
      'wrc',
      'assetto corsa',
      'iracing',
      'wreckfest',
      'project cars',
      'rfactor',
      'trackmania',
      'the crew',
      'burnout',
      'mario kart',
      'beamng',
    ],
  },
  // Tactical-shooter labeler (src/detectors/tacticalFilter.js). Same local-Ollama
  // labeling mechanism as racingFilter: adds a category (breach, firefight,
  // arrest, ...) to candidates from tactical shooters (Ready or Not, Ground
  // Branch, ...) without ever dropping them — prompts are unvalidated against
  // real Ready or Not footage, so this stays non-destructive until there's
  // footage to tune against. OCR-dependent categories (kill feed, mission-end
  // banner, objective text) are deferred — see tacticalFilter.js header.
  tacticalFilter: {
    enabled: true,
    ollamaHost: 'http://localhost:11434',
    model: 'gemma3:4b', // same model as combat/racing; re-evaluate on real tactical frames
    framesPerHighlight: 3,
    frameWidth: 640,
    frameTimeoutMs: 60 * 1000,
    ytFormat: 'best[height<=480]/best',
    // Deliberately tactical-shooter-specific (slow, methodical, squad-based
    // CQB/milsim titles) — NOT generic arena/hero FPS like Call of Duty or
    // Valorant, which are a different play style with different key moments.
    // Case-insensitive substring match, so multi-word entries are used where a
    // short one would false-match unrelated titles ('arma 3' not 'arma', which
    // would hit "Armada"; no bare 'squad').
    tacticalGameKeywords: [
      'ready or not',
      'swat',
      'ground branch',
      'zero hour',
      'six days in fallujah',
      'insurgency',
      'rainbow six',
      'door kickers',
      'arma 3',
      'arma reforger',
      'ghost recon',
    ],
  },
  // Sports-game labeler (src/detectors/sportsFilter.js). Same local-Ollama
  // labeling mechanism as racing/tacticalFilter: adds a category (score
  // banner, celebration, replay, ...) to candidates from structured-match
  // sports titles (EA Sports FC, Madden, NBA 2K, ...) without ever dropping
  // them — prompts are unvalidated against real footage of these games, so
  // this stays non-destructive until there's footage to tune against.
  // Context-aware weighting (score differential, game clock, match
  // importance) and OCR-dependent categories (overtime, records) are
  // deferred — see sportsFilter.js header for why.
  sportsFilter: {
    enabled: true,
    ollamaHost: 'http://localhost:11434',
    model: 'gemma3:4b', // same model as combat/racing/tactical; re-evaluate on real sports frames
    framesPerHighlight: 3,
    frameWidth: 640,
    frameTimeoutMs: 60 * 1000,
    ytFormat: 'best[height<=480]/best',
    // Structured-match sports titles: clear objectives, scoring, and
    // broadcast-style presentation (replays, celebrations, score graphics) —
    // which is exactly what the prompts key on. Rocket League qualifies (goals,
    // auto-replays, celebrations) even though the "athletes" are cars.
    // Case-insensitive substring match, so entries are chosen not to
    // false-match unrelated titles: 'nhl 2' not bare 'nhl' (same pattern as
    // racing's 'f1 2'), and no 'football manager' — a menu-driven management
    // sim, not on-pitch gameplay, so these prompts would label nothing.
    sportsGameKeywords: [
      'fifa',
      'ea sports fc',
      'efootball',
      'pro evolution soccer',
      'madden',
      'college football',
      'nba 2k',
      'nba live',
      'mlb the show',
      'super mega baseball',
      'nhl 2',
      'rocket league',
      'pga tour',
    ],
  },
};

export const editing = {
  // Silence/dead-air trimming (src/processing/silenceTrim.js). Unvalidated
  // against real racing-game audio (engine idle, garage/menu navigation,
  // quiet cinematics) — worth a tuning pass once there's real footage to
  // judge against, same as detector.motion.sceneThreshold.
  silence: {
    noiseDb: '-30dB',
    minDurationSec: 1.0,
    keepPadSec: 0.3, // breathing room left on each side of a cut
  },
};

export default { video, detector, editing };
