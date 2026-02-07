import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, LOG_RETENTION_DAYS } from './config.js';
import { setLogSyncStream } from './logger.js';
import {
  insertLog,
  insertContainerLog,
  isContainerLogIndexed,
  pruneOldLogs,
  type LogEntry,
} from './db.js';
import { logger } from './logger.js';

export interface StructuredLog {
  id: number;
  level: number;
  time: number;
  msg: string;
  module?: string;
  group_folder?: string;
}

const RING_BUFFER_SIZE = 500;
const CONTAINER_INDEX_INTERVAL = 30_000; // 30s

const ringBuffer: StructuredLog[] = [];
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

let containerIndexerInterval: ReturnType<typeof setInterval> | null = null;

function createLogCaptureStream(): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const logEntry: Omit<LogEntry, 'id'> = {
              level: parsed.level ?? 30,
              time: parsed.time ?? Date.now(),
              msg: parsed.msg ?? '',
              module: parsed.module ?? parsed.name ?? null,
              group_folder: parsed.group_folder ?? null,
              raw: line,
            };

            const id = insertLog(logEntry);

            const structured: StructuredLog = {
              id,
              level: logEntry.level,
              time: logEntry.time,
              msg: logEntry.msg,
              module: logEntry.module ?? undefined,
              group_folder: logEntry.group_folder ?? undefined,
            };

            // Push to ring buffer
            ringBuffer.push(structured);
            if (ringBuffer.length > RING_BUFFER_SIZE) {
              ringBuffer.shift();
            }

            // Emit for SSE subscribers
            logEmitter.emit('log', structured);
          } catch {
            // Skip unparseable lines (e.g. pino-pretty output)
          }
        }
      } catch {
        // Swallow errors to prevent backpressure on logger
      }
      cb();
    },
  });
}

function indexContainerLogs(): void {
  try {
    if (!fs.existsSync(GROUPS_DIR)) return;

    const groups = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    for (const group of groups) {
      if (!group.isDirectory()) continue;

      const logsDir = path.join(GROUPS_DIR, group.name, 'logs');
      if (!fs.existsSync(logsDir)) continue;

      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      for (const file of files) {
        if (isContainerLogIndexed(file)) continue;

        const filePath = path.join(logsDir, file);
        try {
          const stat = fs.statSync(filePath);
          // Read first 2KB for header metadata
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(2048);
          const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
          fs.closeSync(fd);
          const header = buf.subarray(0, bytesRead).toString('utf8');

          // Parse metadata from header
          const modeMatch = header.match(/mode:\s*(one-shot|persistent)/i);
          const timestampMatch = header.match(
            /timestamp:\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i,
          );
          const durationMatch = header.match(/duration:\s*(\d+)/i);
          const exitMatch = header.match(/exit[_ ]code:\s*(\d+)/i);
          const statusMatch = header.match(/status:\s*(\w+)/i);
          const mainMatch = header.match(/is[_ ]main:\s*(true|false)/i);

          insertContainerLog({
            group_folder: group.name,
            filename: file,
            timestamp: timestampMatch?.[1] ?? null,
            duration_ms: durationMatch ? parseInt(durationMatch[1], 10) : null,
            exit_code: exitMatch ? parseInt(exitMatch[1], 10) : null,
            mode: modeMatch?.[1] ?? null,
            is_main: mainMatch ? (mainMatch[1] === 'true' ? 1 : 0) : null,
            status: statusMatch?.[1] ?? null,
            file_size: stat.size,
            indexed_at: new Date().toISOString(),
          });
        } catch {
          // Skip files we can't read
        }
      }
    }
  } catch {
    // Swallow indexer errors
  }
}

export function getRingBuffer(): StructuredLog[] {
  return [...ringBuffer];
}

export function getRingBufferSince(afterId: number): StructuredLog[] {
  const idx = ringBuffer.findIndex((entry) => entry.id > afterId);
  if (idx === -1) return [];
  return ringBuffer.slice(idx);
}

export function initLogSync(): void {
  const captureStream = createLogCaptureStream();
  setLogSyncStream(captureStream);

  // Run initial container log indexing
  indexContainerLogs();

  // Poll for new container logs periodically
  containerIndexerInterval = setInterval(
    indexContainerLogs,
    CONTAINER_INDEX_INTERVAL,
  );

  logger.info('Log sync initialized');
}

export function stopLogSync(): void {
  if (containerIndexerInterval) {
    clearInterval(containerIndexerInterval);
    containerIndexerInterval = null;
  }
}

export function pruneOldLogEntries(): void {
  const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const deleted = pruneOldLogs(retentionMs);
  if (deleted > 0) {
    logger.info({ deleted }, 'Pruned old log entries');
  }
}
