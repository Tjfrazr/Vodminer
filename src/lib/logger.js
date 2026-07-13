import pino from 'pino';
import { env } from './env.js';

// sync: true — pino's default async writer (SonicBoom) can lose the final
// log line when process.exit() is called right after logging (see index.js
// catch handlers), which is exactly the case we need logs from most.
export const logger = pino({ level: env.LOG_LEVEL }, pino.destination({ sync: true }));

export default logger;
