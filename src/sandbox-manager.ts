import { execSync, exec } from 'child_process';
import { randomBytes } from 'crypto';
import {
  CUA_API_KEY,
  CUA_SANDBOX_COMMAND_PORT,
  CUA_SANDBOX_CONTAINER_NAME,
  CUA_SANDBOX_IMAGE,
  CUA_SANDBOX_NOVNC_PORT,
  CUA_SANDBOX_PLATFORM,
  CUA_SANDBOX_SCREEN_DEPTH,
  CUA_SANDBOX_SCREEN_HEIGHT,
  CUA_SANDBOX_SCREEN_WIDTH,
  CUA_SANDBOX_SHM_SIZE,
  CUA_SANDBOX_VNC_PORT,
  SANDBOX_IDLE_TIMEOUT_MS,
  SANDBOX_TAILSCALE_ENABLED,
} from './config.js';
import { logger } from './logger.js';

let lastBrowseActivity = 0;
let idleWatcherInterval: ReturnType<typeof setInterval> | null = null;
let cachedTailscaleIp: string | null = null;
let currentVncPassword: string | null = null;

function generateVncPassword(): string {
  return randomBytes(16).toString('base64url');
}

export interface SandboxConnection {
  commandUrl: string;
  liveViewUrl: string | null;
}

function isContainerRunning(name: string): boolean {
  try {
    const result = execSync(
      `docker inspect --format '{{.State.Running}}' ${name}`,
      {
        stdio: 'pipe',
      },
    )
      .toString()
      .trim();
    return result === 'true';
  } catch {
    return false;
  }
}

function removeContainerIfPresent(name: string): void {
  try {
    execSync(`docker rm ${name}`, { stdio: 'pipe' });
  } catch {
    // Container may not exist
  }
}

function startCuaSandbox(): void {
  logger.info('Starting CUA desktop sandbox container');
  const resolution = `${CUA_SANDBOX_SCREEN_WIDTH}x${CUA_SANDBOX_SCREEN_HEIGHT}`;
  const envArgs = [
    // Preferred vars for trycua/cua-xfce.
    `-e VNC_RESOLUTION=${resolution}`,
    `-e VNC_COL_DEPTH=${CUA_SANDBOX_SCREEN_DEPTH}`,
    // Backward-compatible vars for older CUA images.
    `-e SCREEN_WIDTH=${CUA_SANDBOX_SCREEN_WIDTH}`,
    `-e SCREEN_HEIGHT=${CUA_SANDBOX_SCREEN_HEIGHT}`,
    `-e SCREEN_DEPTH=${CUA_SANDBOX_SCREEN_DEPTH}`,
  ];
  if (CUA_API_KEY) {
    envArgs.push(`-e CUA_API_KEY=${CUA_API_KEY}`);
  }

  // Generate a random VNC password for this sandbox instance
  currentVncPassword = generateVncPassword();
  envArgs.push(`-e VNC_PW=${currentVncPassword}`);

  try {
    execSync(
      `docker run -d --name ${CUA_SANDBOX_CONTAINER_NAME} --platform ${CUA_SANDBOX_PLATFORM} --shm-size ${CUA_SANDBOX_SHM_SIZE} -p ${CUA_SANDBOX_COMMAND_PORT}:8000 -p ${CUA_SANDBOX_VNC_PORT}:5901 -p ${CUA_SANDBOX_NOVNC_PORT}:6901 ${envArgs.join(' ')} ${CUA_SANDBOX_IMAGE}`,
      { stdio: 'pipe' },
    );
    logger.info('CUA desktop sandbox started');
  } catch (err) {
    logger.error({ err }, 'Failed to start CUA desktop sandbox');
    throw err;
  }
}

function stopCuaSandbox(): void {
  logger.info('Stopping CUA desktop sandbox');
  currentVncPassword = null;
  try {
    execSync(`docker stop ${CUA_SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not be running
  }
  removeContainerIfPresent(CUA_SANDBOX_CONTAINER_NAME);
}

export function isSandboxRunning(): boolean {
  return isContainerRunning(CUA_SANDBOX_CONTAINER_NAME);
}

function waitForCuaReady(): void {
  for (let i = 0; i < 20; i++) {
    try {
      execSync(
        `curl -sf http://localhost:${CUA_SANDBOX_COMMAND_PORT}/health || curl -sf http://localhost:${CUA_SANDBOX_COMMAND_PORT}/`,
        {
          stdio: 'pipe',
          timeout: 3000,
        },
      );
      logger.info('CUA sandbox command server is reachable from host');
      return;
    } catch {
      if (i === 19) {
        logger.warn(
          'CUA sandbox server not reachable after 20 attempts, proceeding anyway',
        );
      }
      execSync('sleep 1', { stdio: 'pipe' });
    }
  }
}

export async function ensureSandbox(): Promise<SandboxConnection> {
  if (!isSandboxRunning()) {
    removeContainerIfPresent(CUA_SANDBOX_CONTAINER_NAME);
    startCuaSandbox();
    waitForCuaReady();
  }

  resetIdleTimer();
  return {
    commandUrl: `http://localhost:${CUA_SANDBOX_COMMAND_PORT}/cmd`,
    liveViewUrl: getSandboxUrl(),
  };
}

export function getSandboxUrl(): string | null {
  if (!isSandboxRunning()) return null;
  const ip = getSandboxHostIp();
  return `http://${ip}:${CUA_SANDBOX_NOVNC_PORT}`;
}

export function getSandboxHostIp(): string {
  if (!SANDBOX_TAILSCALE_ENABLED) return '127.0.0.1';
  return getTailscaleIp();
}

function getTailscaleIp(): string {
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
      Date.now() - lastBrowseActivity > SANDBOX_IDLE_TIMEOUT_MS &&
      isSandboxRunning()
    ) {
      logger.info('Sandbox idle timeout reached, stopping CUA desktop sandbox');
      stopCuaSandbox();
      lastBrowseActivity = 0;
    }
  }, 60_000);
  logger.info('Sandbox idle watcher started (CUA mode)');
}

export function cleanupSandbox(): void {
  if (idleWatcherInterval) {
    clearInterval(idleWatcherInterval);
    idleWatcherInterval = null;
  }
  if (isSandboxRunning()) {
    stopCuaSandbox();
  }
}

export function getSandboxVncPassword(): string | null {
  return currentVncPassword;
}

/**
 * Rotate the VNC password inside the running sandbox container.
 * Generates a new random password, updates it in the container, and returns it.
 * Returns null if the sandbox is not running or password rotation fails.
 */
export async function rotateSandboxVncPassword(): Promise<string | null> {
  if (!isSandboxRunning()) return null;

  const newPassword = generateVncPassword();
  const container = CUA_SANDBOX_CONTAINER_NAME;

  try {
    // Try the rotation helper script first (available in custom sandbox image)
    await execAsync(
      `docker exec ${container} /rotate-vnc-pw.sh ${shellQuote(newPassword)}`,
    );
    currentVncPassword = newPassword;
    logger.info('VNC password rotated via /rotate-vnc-pw.sh');
    return newPassword;
  } catch {
    // Helper script not available (e.g. trycua image) — try inline rotation
  }

  try {
    // Inline fallback: update password file and restart x11vnc directly
    const cmd = [
      `x11vnc -storepasswd ${shellQuote(newPassword)} /tmp/vncpasswd 2>/dev/null`,
      'pkill -x x11vnc 2>/dev/null || true',
      'sleep 0.3',
      'x11vnc -display :99 -forever -shared -rfbport 5900 -rfbauth /tmp/vncpasswd &',
    ].join(' && ');
    await execAsync(`docker exec ${container} bash -c ${shellQuote(cmd)}`);
    currentVncPassword = newPassword;
    logger.info('VNC password rotated via inline exec');
    return newPassword;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to rotate VNC password — sandbox may not support x11vnc password rotation',
    );
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}
