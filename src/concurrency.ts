import { MAX_CONCURRENT_AGENTS } from './config.js';
import { logger } from './logger.js';

/**
 * Simple counting semaphore for limiting concurrent operations.
 * Used to cap the number of simultaneous Docker agent containers.
 */
export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get active(): number {
    return this.current;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

/** Global semaphore limiting concurrent agent containers */
export const agentSemaphore = new Semaphore(MAX_CONCURRENT_AGENTS);

logger.debug(
  { module: 'concurrency', maxConcurrent: MAX_CONCURRENT_AGENTS },
  'Agent concurrency limiter initialized',
);
