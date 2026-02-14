import { execSync, exec } from 'child_process';
import { randomBytes } from 'crypto';
import {
  CUA_API_KEY,
  CUA_SANDBOX_COMMAND_PORT,
  CUA_SANDBOX_CONTAINER_NAME,
  CUA_SANDBOX_HOME_VOLUME,
  CUA_SANDBOX_IMAGE,
  CUA_SANDBOX_NOVNC_PORT,
  CUA_SANDBOX_PERSIST,
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
import { getTailscaleCachedFqdn } from './tailscale-serve.js';

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

function containerExists(name: string): boolean {
  try {
    execSync(`docker inspect ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getContainerImageId(name: string): string | null {
  try {
    return execSync(`docker inspect --format '{{.Image}}' ${name}`, {
      stdio: 'pipe',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getCurrentImageId(imageName: string): string | null {
  try {
    return execSync(`docker inspect --format '{{.Id}}' ${imageName}`, {
      stdio: 'pipe',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isContainerImageStale(
  containerName: string,
  imageName: string,
): boolean {
  const containerImageId = getContainerImageId(containerName);
  const currentImageId = getCurrentImageId(imageName);
  if (!containerImageId || !currentImageId) return true;
  return containerImageId !== currentImageId;
}

function startCuaSandbox(forceRecreate = false): void {
  const name = CUA_SANDBOX_CONTAINER_NAME;

  // When persistence is enabled, try to restart a stopped container
  if (CUA_SANDBOX_PERSIST && !forceRecreate && containerExists(name)) {
    if (isContainerImageStale(name, CUA_SANDBOX_IMAGE)) {
      logger.info(
        { module: 'sandbox' },
        'CUA sandbox image is stale (image updated), recreating container',
      );
      removeContainerIfPresent(name);
      // Fall through to docker run
    } else if (!isContainerRunning(name)) {
      logger.info({ module: 'sandbox' }, 'Restarting existing CUA desktop sandbox (state preserved)');
      try {
        execSync(`docker start ${name}`, { stdio: 'pipe' });
        logger.info({ module: 'sandbox' }, 'CUA desktop sandbox restarted');
        return;
      } catch (err) {
        logger.warn({ module: 'sandbox', err }, 'Failed to restart CUA sandbox, will recreate');
        removeContainerIfPresent(name);
        // Fall through to docker run
      }
    } else {
      logger.debug({ module: 'sandbox' }, 'CUA desktop sandbox is already running');
      return;
    }
  } else {
    removeContainerIfPresent(name);
  }

  logger.info({ module: 'sandbox' }, 'Creating new CUA desktop sandbox container');
  const resolution = `${CUA_SANDBOX_SCREEN_WIDTH}x${CUA_SANDBOX_SCREEN_HEIGHT}`;
  const args = [
    'docker run -d',
    `--name ${name}`,
    `--platform ${CUA_SANDBOX_PLATFORM}`,
    `--shm-size ${CUA_SANDBOX_SHM_SIZE}`,
    `-p ${CUA_SANDBOX_COMMAND_PORT}:8000`,
    `-p ${CUA_SANDBOX_VNC_PORT}:5901`,
    `-p ${CUA_SANDBOX_NOVNC_PORT}:6901`,
    `-e VNC_RESOLUTION=${resolution}`,
    `-e VNC_COL_DEPTH=${CUA_SANDBOX_SCREEN_DEPTH}`,
    `-e SCREEN_WIDTH=${CUA_SANDBOX_SCREEN_WIDTH}`,
    `-e SCREEN_HEIGHT=${CUA_SANDBOX_SCREEN_HEIGHT}`,
    `-e SCREEN_DEPTH=${CUA_SANDBOX_SCREEN_DEPTH}`,
  ];
  if (CUA_API_KEY) {
    args.push(`-e CUA_API_KEY=${CUA_API_KEY}`);
  }
  if (CUA_SANDBOX_PERSIST) {
    args.push(`-v ${CUA_SANDBOX_HOME_VOLUME}:/home/cua`);
  }

  // Generate a random VNC password for this sandbox instance
  currentVncPassword = generateVncPassword();
  args.push(`-e VNC_PW=${currentVncPassword}`);

  args.push(CUA_SANDBOX_IMAGE);

  try {
    execSync(args.join(' '), { stdio: 'pipe' });
    logger.info({ module: 'sandbox' }, 'CUA desktop sandbox started');
  } catch (err) {
    logger.error({ module: 'sandbox', err }, 'Failed to start CUA desktop sandbox');
    throw err;
  }
}

function stopCuaSandbox(): void {
  logger.info({ module: 'sandbox' }, 'Stopping CUA desktop sandbox');
  currentVncPassword = null;
  try {
    execSync(`docker stop ${CUA_SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not be running
  }
  if (!CUA_SANDBOX_PERSIST) {
    removeContainerIfPresent(CUA_SANDBOX_CONTAINER_NAME);
  }
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
      logger.info({ module: 'sandbox' }, 'CUA sandbox command server is reachable from host');
      return;
    } catch {
      if (i === 19) {
        logger.warn(
          { module: 'sandbox' },
          'CUA sandbox server not reachable after 20 attempts, proceeding anyway',
        );
      }
      execSync('sleep 1', { stdio: 'pipe' });
    }
  }
}

export async function ensureSandbox(): Promise<SandboxConnection> {
  if (!isSandboxRunning()) {
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
  const fqdn = SANDBOX_TAILSCALE_ENABLED ? getTailscaleCachedFqdn() : null;
  const host = fqdn || getSandboxHostIp();
  return `http://${host}:${CUA_SANDBOX_NOVNC_PORT}`;
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
    logger.info({ module: 'sandbox', ip: cachedTailscaleIp }, 'Tailscale IP resolved');
    return cachedTailscaleIp;
  } catch {
    logger.warn({ module: 'sandbox' }, 'Could not resolve Tailscale IP, falling back to 127.0.0.1');
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
      logger.info({ module: 'sandbox' }, 'Sandbox idle timeout reached, stopping CUA desktop sandbox');
      stopCuaSandbox();
      lastBrowseActivity = 0;
    }
  }, 60_000);
  logger.info({ module: 'sandbox' }, 'Sandbox idle watcher started (CUA mode)');
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

/** Force-recreate the sandbox container. Named volume is preserved. */
export function resetSandbox(): void {
  logger.info({ module: 'sandbox' }, 'Force-resetting CUA desktop sandbox (will recreate)');
  try {
    execSync(`docker stop ${CUA_SANDBOX_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not be running
  }
  removeContainerIfPresent(CUA_SANDBOX_CONTAINER_NAME);
}

/** Full reset: remove container AND wipe the home volume data. */
export function resetSandboxFull(): void {
  logger.info({ module: 'sandbox' }, 'Full CUA sandbox reset (container + volume data)');
  resetSandbox();
  if (CUA_SANDBOX_PERSIST) {
    try {
      execSync(`docker volume rm ${CUA_SANDBOX_HOME_VOLUME}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
      logger.info(
        { module: 'sandbox', volume: CUA_SANDBOX_HOME_VOLUME },
        'Removed CUA home volume',
      );
    } catch {
      // Volume may not exist or container still releasing it
    }
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
    logger.info({ module: 'sandbox' }, 'VNC password rotated via /rotate-vnc-pw.sh');
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
    logger.info({ module: 'sandbox' }, 'VNC password rotated via inline exec');
    return newPassword;
  } catch (err) {
    logger.warn(
      { module: 'sandbox', err: err instanceof Error ? err.message : String(err) },
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
