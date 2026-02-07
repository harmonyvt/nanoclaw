import pino from 'pino';
import pretty from 'pino-pretty';
import { Writable } from 'node:stream';

let logSyncStream: Writable | null = null;

export function setLogSyncStream(stream: Writable): void {
  logSyncStream = stream;
}

const logCapture = new Writable({
  write(chunk, _enc, cb) {
    logSyncStream ? logSyncStream.write(chunk, cb) : cb();
  },
});

const level = (process.env.LOG_LEVEL || 'info') as pino.Level;

export const logger = pino(
  { level },
  pino.multistream([
    { stream: pretty({ colorize: true }), level },
    { stream: logCapture, level },
  ]),
);
