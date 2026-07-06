import { spawn } from 'node:child_process';

// Resolve the direct HLS manifest (m3u8) URL for a VOD via `yt-dlp -g` — no
// download happens. ffmpeg then reads the m3u8 natively, fetching segments
// itself. This avoids yt-dlp's `-o -` stdout-pipe mode, which stages every HLS
// fragment as a `--FragN` temp file in the CWD and intermittently loses a
// read-back race on Windows ("[Errno 2] No such file or directory: '--FragN'"),
// killing multi-hundred-MB downloads near the end. See ERRORS.md.
export function resolveStreamUrl(vodUrl, format, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const yt = spawn('yt-dlp', ['-g', '-f', format, '--no-warnings', vodUrl]);

    let out = '';
    let err = '';
    let settled = false;

    function finish(e, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      yt.kill('SIGKILL');
      if (e) reject(e); else resolve(url);
    }

    const timer = setTimeout(
      () => finish(new Error(`yt-dlp -g timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    yt.stdout.on('data', (d) => { out += d.toString(); });
    yt.stderr.on('data', (d) => { err += d.toString(); });
    yt.on('error', finish);
    yt.on('close', (code) => {
      if (code !== 0) return finish(new Error(`yt-dlp -g exit ${code}: ${err.slice(-500)}`));
      const url = out.split('\n').map((s) => s.trim()).find(Boolean);
      if (!url) return finish(new Error('yt-dlp -g returned no URL'));
      finish(null, url);
    });
  });
}
