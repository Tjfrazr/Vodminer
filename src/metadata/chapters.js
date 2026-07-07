// Formats YouTube chapter markers from the bot's own highlight detection —
// not a transcript pause-gap heuristic, since there's no mic/commentary to
// find pauses in. YouTube's chapter rules: first chapter must be 0:00,
// minimum 3 chapters, each chapter >=10s apart from the next.
const MIN_CHAPTERS = 3;
const MIN_GAP_SEC = 10;

const REASON_LABELS = {
  audio_transient: 'Audio Highlight',
  motion: 'Action Moment',
  viewer_clip: 'Viewer Clip',
};

function fmtTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function labelFor(highlight, countByReason) {
  const base = REASON_LABELS[highlight.reason] ?? 'Highlight';
  const n = (countByReason[highlight.reason] = (countByReason[highlight.reason] ?? 0) + 1);
  return n === 1 ? base : `${base} ${n}`;
}

// Builds chapter lines from a highlight list (each { startSec, reason }).
// Returns null if fewer than MIN_CHAPTERS can be produced (YouTube would
// reject the chapters and show none) — caller should omit chapters from the
// description entirely in that case, not send an invalid partial list.
export function buildChapters(highlights, { totalDurationSec } = {}) {
  const sorted = [...highlights].sort((a, b) => a.startSec - b.startSec);

  // Enforce the >=10s-apart rule by dropping any highlight too close to the
  // previous kept one, starting from a forced 0:00 entry.
  const kept = [{ startSec: 0, reason: null }];
  for (const h of sorted) {
    const prev = kept[kept.length - 1];
    if (h.startSec - prev.startSec >= MIN_GAP_SEC) {
      kept.push(h);
    }
  }
  if (totalDurationSec) {
    // Drop a trailing chapter too close to the end — YouTube also rejects that.
    while (kept.length > 1 && totalDurationSec - kept[kept.length - 1].startSec < MIN_GAP_SEC) {
      kept.pop();
    }
  }

  if (kept.length < MIN_CHAPTERS) return null;

  const countByReason = {};
  const lines = kept.map((h, i) =>
    i === 0
      ? `0:00 Stream Start`
      : `${fmtTimestamp(h.startSec)} ${labelFor(h, countByReason)}`,
  );
  return lines.join('\n');
}

export default { buildChapters };
