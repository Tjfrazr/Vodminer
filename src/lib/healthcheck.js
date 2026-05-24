import { spawnSync } from 'node:child_process';
import { logger } from './logger.js';

const REQUIRED_BINARIES = ['ffmpeg', 'ffprobe', 'yt-dlp'];
const MIN_NODE_MAJOR = 20;

function checkBinary(name) {
  try {
    const result = spawnSync(name, ['-version'], { stdio: 'ignore' });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    ok: Number.isFinite(major) && major >= MIN_NODE_MAJOR,
    actual: process.versions.node,
  };
}

/**
 * Verify the host has everything needed to run Vodminer.
 * - Required PATH binaries: ffmpeg, ffprobe, yt-dlp
 * - Node.js >= 20
 * - Required env vars (verified transitively by importing env.js, which throws on missing)
 *
 * Collects all failures before throwing so the operator sees the full list at once.
 */
export async function assertHostReady() {
  const failures = [];

  for (const bin of REQUIRED_BINARIES) {
    if (!checkBinary(bin)) {
      failures.push(`Missing PATH binary: ${bin}`);
    }
  }

  const node = checkNodeVersion();
  if (!node.ok) {
    failures.push(`Node.js >= ${MIN_NODE_MAJOR} required (found ${node.actual})`);
  }

  // Importing env.js triggers its required-var validation. If anything is missing
  // it throws synchronously; we catch and aggregate so we report alongside binary issues.
  try {
    await import('./env.js');
  } catch (err) {
    failures.push(`Environment: ${err.message}`);
  }

  if (failures.length > 0) {
    const msg = `Host readiness check failed:\n  - ${failures.join('\n  - ')}`;
    logger.error({ failures }, 'host readiness check failed');
    throw new Error(msg);
  }

  logger.info('host readiness check passed');
}

export default assertHostReady;
