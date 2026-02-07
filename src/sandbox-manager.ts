import { execSync } from 'child_process';
import { logger } from './logger.js';

const SANDBOX_CONTAINER_NAME = 'nanoclaw-sandbox';
const SANDBOX_IMAGE = 'nanoclaw-sandbox:latest';
const CDP_PORT = 9222;
const NOVNC_PORT = 6080;
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SANDBOX_VOLUME = 'nanoclaw-sandbox-profile';

let lastBrowseActivity = 0;
let idleWatcherInterval: ReturnType<typeof setInterval> | null = null;
let cachedTailscaleIp: string | null = null;

export function isSandboxRunning(): boolean {
  try {
    const result = execSync(
      `docker inspect --format '{{.State.Running}}' ${SANDBOX_CONTAINER_NAME}`,
      { stdio: 'pipe' },
    )
      .toString()
      .trim();
    return result === 'true';
  } catch {
    return false;
  }
}

export function startSandbox(): void {
  logger.info('Starting sandbox container');
  try {
    execSync(
      `docker run -d --name ${SANDBOX_CONTAINER_NAME} -p ${CDP_PORT}:${CDP_PORT} -p ${NOVNC_PORT}:${NOVNC_PORT} -v ${SANDBOX_VOLUME}:/data/chrome-profile ${SANDBOX_IMAGE}`,
      { stdio: 'pipe' },
    );
    logger.info('Sandbox container started');
  } catch (err) {
    logger.error({ err }, 'Failed to start sandbox container');
    throw err;
  }
}

export function stopSandbox(): void {
  logger.info('Stopping sandbox container');
  try {
    execSync(`docker stop ${SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not be running
  }
  try {
    execSync(`docker rm ${SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not exist
  }
  logger.info('Sandbox container stopped');
}

export function ensureSandbox(): string {
  if (!isSandboxRunning()) {
    // Remove stale container if it exists but isn't running
    try {
      execSync(`docker rm ${SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
    } catch {
      // No stale container
    }
    startSandbox();
  }
  resetIdleTimer();
  return `http://localhost:${CDP_PORT}`;
}

export function getSandboxUrl(): string | null {
  if (!isSandboxRunning()) return null;
  const ip = getTailscaleIp();
  return `http://${ip}:${NOVNC_PORT}`;
}

export function getTailscaleIp(): string {
  if (cachedTailscaleIp) return cachedTailscaleIp;
  try {
    cachedTailscaleIp = execSync('tailscale ip -4', { stdio: 'pipe' })
      .toString()
      .trim();
    logger.info({ ip: cachedTailscaleIp }, 'Tailscale IP resolved');
    return cachedTailscaleIp;
  } catch {
    logger.warn('Could not resolve Tailscale IP, falling back to 127.0.0.1');
    return '127.0.0.1';
  }
}

export function resetIdleTimer(): void {
  lastBrowseActivity = Date.now();
}

export function startIdleWatcher(): void {
  if (idleWatcherInterval) return;
  idleWatcherInterval = setInterval(() => {
    if (
      lastBrowseActivity > 0 &&
      Date.now() - lastBrowseActivity > IDLE_TIMEOUT &&
      isSandboxRunning()
    ) {
      logger.info('Sandbox idle timeout reached, stopping');
      stopSandbox();
      lastBrowseActivity = 0;
    }
  }, 60_000); // Check every minute
  logger.info('Sandbox idle watcher started');
}

export function cleanupSandbox(): void {
  if (idleWatcherInterval) {
    clearInterval(idleWatcherInterval);
    idleWatcherInterval = null;
  }
  if (isSandboxRunning()) {
    stopSandbox();
  }
}
