export const video = {
  width: 1080,
  height: 1920,
  codec: 'libx264',
  container: 'mp4',
  maxDurationSec: 60,
  maxSizeBytes: 1024 * 1024 * 1024,
};

export const tiktok = {
  dailyPostLimit: 25,
  isAiGenerated: false,
};

export const schedule = {
  postWindowStartHour: 19,
  postWindowEndHour: 22,
  minSpacingHours: 2,
  maxSpacingHours: 3,
};

export const detector = {
  TODO_PHASE_1_DATA: true,
};

export default { video, tiktok, schedule, detector };
