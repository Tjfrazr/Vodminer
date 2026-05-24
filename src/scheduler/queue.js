import { EventEmitter } from 'node:events';
import { schedule as scheduleCfg, tiktok as tiktokCfg } from '../../config.js';
import { logger } from '../lib/logger.js';

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createQueue({ poster, now = () => new Date(), intervalMs = 60_000 } = {}) {
  const jobs = [];
  const emitter = new EventEmitter();
  let lastPostAt = null;
  let daily = { date: todayKey(now()), count: 0 };
  let timer = null;
  let posting = false;

  function resetIfNewDay(current) {
    const key = todayKey(current);
    if (key !== daily.date) {
      daily = { date: key, count: 0 };
    }
  }

  function inWindow(current) {
    const h = current.getHours();
    return h >= scheduleCfg.postWindowStartHour && h < scheduleCfg.postWindowEndHour;
  }

  function spacingOk(current) {
    if (!lastPostAt) return true;
    const elapsedMs = current.getTime() - lastPostAt.getTime();
    return elapsedMs >= scheduleCfg.minSpacingHours * 60 * 60 * 1000;
  }

  function enqueue(job) {
    jobs.push(job);
    logger.info({ clipId: job?.clipId, queueDepth: jobs.length }, 'queue.enqueue');
    emitter.emit('enqueued', job);
  }

  function peek() {
    return jobs[0];
  }

  function dequeue() {
    return jobs.shift();
  }

  async function tick() {
    if (posting) return;
    const current = now();
    resetIfNewDay(current);

    if (jobs.length === 0) return;
    if (!inWindow(current)) return;
    if (!spacingOk(current)) return;
    if (daily.count >= tiktokCfg.dailyPostLimit) {
      logger.warn({ count: daily.count }, 'queue.dailyLimitReached');
      return;
    }

    const job = dequeue();
    posting = true;
    try {
      logger.info({ clipId: job.clipId }, 'queue.posting');
      await poster(job);
      lastPostAt = now();
      daily.count += 1;
      emitter.emit('posted', job);
    } catch (err) {
      logger.warn({ err: err?.message, clipId: job?.clipId }, 'queue.postFailed');
      jobs.unshift(job);
    } finally {
      posting = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((err) => logger.warn({ err: err?.message }, 'queue.tickError'));
    }, intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function drain() {
    stop();
    while (jobs.length > 0 && daily.count < tiktokCfg.dailyPostLimit) {
      const job = dequeue();
      try {
        await poster(job);
        daily.count += 1;
      } catch (err) {
        logger.warn({ err: err?.message, clipId: job?.clipId }, 'queue.drainPostFailed');
      }
    }
  }

  return {
    enqueue,
    peek,
    dequeue,
    tick,
    start,
    stop,
    drain,
    size: () => jobs.length,
    on: (evt, fn) => emitter.on(evt, fn),
  };
}

export default createQueue;
