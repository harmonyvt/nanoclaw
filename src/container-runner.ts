/**
 * Container Runner for NanoClaw
 * Supports two modes:
 * - Persistent (default): Long-lived containers with file-based IPC, eliminating ~3s startup overhead
 * - One-shot (fallback): Spawns docker run per message via stdin/stdout
 *
 * Persistent containers are tracked per group and automatically cleaned up after idle timeout.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

// Sentinel markers for robust output parsing (must match agent-runner, used in one-shot mode)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Persistent container constants
const CONTAINER_IDLE_TIMEOUT = 10 * 60 * 1000;     // 10 minutes
const IDLE_CHECK_INTERVAL = 2 * 60 * 1000;         // Check every 2 minutes
const HEARTBEAT_WAIT_TIMEOUT = 30_000;              // 30s to wait for container to become ready
const HEARTBEAT_POLL_INTERVAL = 300;                // Poll heartbeat every 300ms
const OUTPUT_POLL_INTERVAL = 200;                   // Poll for output file every 200ms
const HEARTBEAT_STALE_THRESHOLD = 30_000;           // Heartbeat older than 30s = stale

// Use env var to force one-shot mode
const FORCE_ONESHOT = process.env.NANOCLAW_ONESHOT === '1';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

interface CredentialResult {
  lines: string[];
  source: 'dotenv' | 'keychain' | 'claude-credentials' | 'none';
}

interface PersistentContainer {
  containerId: string;
  groupFolder: string;
  lastUsed: number;
  ipcDir: string;       // Host-side IPC dir for this group
}

// ─── Persistent Container Tracking ───────────────────────────────────────────

const runningContainers = new Map<string, PersistentContainer>();
let idleCleanupTimer: ReturnType<typeof setInterval> | null = null;

// ─── Credential Resolution ───────────────────────────────────────────────────

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

/**
 * Read Claude Code OAuth credentials from macOS keychain.
 * Returns the parsed JSON or null if unavailable.
 */
function readKeychainCredentials(): {
  accessToken: string;
  expiresAt?: number;
} | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    if (!accessToken) return null;
    return {
      accessToken,
      expiresAt: parsed?.claudeAiOauth?.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Check OAuth token expiration and log warnings.
 */
function checkTokenExpiry(expiresAt: number | undefined): void {
  if (!expiresAt) return;
  const nowMs = Date.now();
  if (expiresAt <= nowMs) {
    logger.warn(
      'Claude Code OAuth token has expired — Claude Code should auto-refresh it on next use',
    );
  } else if (expiresAt - nowMs < 10 * 60 * 1000) {
    logger.warn(
      { expiresIn: Math.round((expiresAt - nowMs) / 1000) },
      'Claude Code OAuth token expires within 10 minutes',
    );
  }
}

/**
 * Resolve auth credentials with fallback chain:
 * 1. .env file (allowed API keys and tokens)
 * 2. macOS keychain (Claude Code's OAuth token)
 * 3. ~/.claude/.credentials.json (Claude Code's cached OAuth token)
 */
function resolveCredentials(): CredentialResult {
  const projectRoot = process.cwd();
  const homeDir = getHomeDir();
  const envFile = path.join(projectRoot, '.env');

  // Collect non-auth API keys from .env (always included regardless of auth source)
  const extraVars = ['OPENAI_API_KEY', 'FIRECRAWL_API_KEY'];
  const extraLines: string[] = [];
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (extraVars.some((v) => trimmed.startsWith(`${v}=`))) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);
        if (!val) continue;
        const escaped = val.replace(/'/g, "'\\''");
        extraLines.push(`${key}='${escaped}'`);
      }
    }
  }

  // Priority 1: .env file for Claude auth (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
  const authVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const authLines: string[] = [];
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (authVars.some((v) => trimmed.startsWith(`${v}=`))) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);
        if (!val) continue;
        const escaped = val.replace(/'/g, "'\\''");
        authLines.push(`${key}='${escaped}'`);
      }
    }
    if (authLines.length > 0) {
      return { lines: [...authLines, ...extraLines], source: 'dotenv' };
    }
  }

  // Priority 2: macOS keychain (Claude Code stores OAuth here)
  const keychainCreds = readKeychainCredentials();
  if (keychainCreds) {
    checkTokenExpiry(keychainCreds.expiresAt);
    const escaped = keychainCreds.accessToken.replace(/'/g, "'\\''");
    logger.info('Using Claude Code OAuth token from macOS keychain');
    return {
      lines: [`CLAUDE_CODE_OAUTH_TOKEN='${escaped}'`, ...extraLines],
      source: 'keychain',
    };
  }

  // Priority 3: Claude Code credentials file
  const credentialsPath = path.join(homeDir, '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credentialsPath)) {
      const raw = fs.readFileSync(credentialsPath, 'utf-8');
      const credentials = JSON.parse(raw);
      const accessToken = credentials?.claudeAiOauth?.accessToken;
      if (!accessToken) {
        logger.debug(
          'Credentials file found but missing claudeAiOauth.accessToken',
        );
        return { lines: extraLines, source: 'none' };
      }

      checkTokenExpiry(credentials?.claudeAiOauth?.expiresAt);

      const escaped = accessToken.replace(/'/g, "'\\''");
      return {
        lines: [`CLAUDE_CODE_OAUTH_TOKEN='${escaped}'`, ...extraLines],
        source: 'claude-credentials',
      };
    }
  } catch (err) {
    logger.debug(
      { error: err, path: credentialsPath },
      'Failed to read credentials file',
    );
  }

  if (extraLines.length > 0) {
    return { lines: extraLines, source: 'none' };
  }
  return { lines: [], source: 'none' };
}

// ─── Volume Mounts ───────────────────────────────────────────────────────────

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Apple Container only supports directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/bun/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  // Persistent mode IPC subdirectories
  fs.mkdirSync(path.join(groupIpcDir, 'agent-input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'agent-output'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const credentials = resolveCredentials();
  if (credentials.lines.length > 0) {
    logger.debug(
      { source: credentials.source },
      'Container auth credentials resolved',
    );
    fs.writeFileSync(
      path.join(envDir, 'env'),
      credentials.lines.join('\n') + '\n',
    );
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  } else {
    logger.warn(
      'No auth credentials found — check .env or Claude Code login (claude login)',
    );
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

// ─── One-shot Mode (original behavior) ───────────────────────────────────────

function buildOneShotContainerArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

async function runOneShotContainer(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const containerArgs = buildOneShotContainerArgs(mounts);

  logger.debug(
    {
      group: group.name,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration (one-shot)',
  );

  logger.info(
    {
      group: group.name,
      mountCount: mounts.length,
      isMain: input.isMain,
      mode: 'one-shot',
    },
    'Spawning container agent (one-shot)',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn(
          { group: group.name, size: stdout.length },
          'Container stdout truncated due to size limit',
        );
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`,
      });
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log (one-shot) ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      if (isVerbose) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );

        if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500),
            ``,
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderr.slice(-500),
            logFile,
          },
          'Container exited with error (one-shot)',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed (one-shot)',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: stdout.slice(-500),
            error: err,
          },
          'Failed to parse container output (one-shot)',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Container spawn error (one-shot)');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

// ─── Persistent Mode ─────────────────────────────────────────────────────────

function buildPersistentContainerArgs(mounts: VolumeMount[]): string[] {
  // Detached, no --rm (we manage lifecycle), with persistent env var
  const args: string[] = ['run', '-d', '-e', 'NANOCLAW_PERSISTENT=1'];

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Check if a container is still running via docker inspect.
 */
function isContainerRunning(containerId: string): boolean {
  try {
    const result = execSync(
      `docker inspect -f '{{.State.Running}}' ${containerId} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Read the heartbeat file and check if it's recent enough.
 */
function isHeartbeatAlive(groupFolder: string): boolean {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const heartbeatPath = path.join(groupIpcDir, 'agent-heartbeat');

  try {
    if (!fs.existsSync(heartbeatPath)) return false;
    const data = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
    const age = Date.now() - data.timestamp;
    return age < HEARTBEAT_STALE_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Wait for the container's heartbeat file to appear, indicating the agent is ready.
 */
async function waitForHeartbeat(groupFolder: string, containerId: string): Promise<boolean> {
  const deadline = Date.now() + HEARTBEAT_WAIT_TIMEOUT;

  while (Date.now() < deadline) {
    // Check if container died
    if (!isContainerRunning(containerId)) {
      logger.error(
        { groupFolder, containerId: containerId.slice(0, 12) },
        'Container exited while waiting for heartbeat',
      );
      return false;
    }

    if (isHeartbeatAlive(groupFolder)) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_POLL_INTERVAL));
  }

  logger.error(
    { groupFolder, containerId: containerId.slice(0, 12) },
    'Timed out waiting for container heartbeat',
  );
  return false;
}

/**
 * Kill and clean up a persistent container.
 */
function killContainer(groupFolder: string, reason: string): void {
  const entry = runningContainers.get(groupFolder);
  if (!entry) return;

  logger.info(
    {
      groupFolder,
      containerId: entry.containerId.slice(0, 12),
      reason,
    },
    'Killing persistent container',
  );

  try {
    execSync(`docker kill ${entry.containerId} 2>/dev/null`, { timeout: 10000 });
  } catch {
    // Container may already be dead
  }

  try {
    execSync(`docker rm -f ${entry.containerId} 2>/dev/null`, { timeout: 10000 });
  } catch {
    // Best effort cleanup
  }

  // Clean up heartbeat file
  const heartbeatPath = path.join(DATA_DIR, 'ipc', groupFolder, 'agent-heartbeat');
  try { fs.unlinkSync(heartbeatPath); } catch {}

  // Clean up any stale input files
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'agent-input');
  try {
    if (fs.existsSync(inputDir)) {
      for (const f of fs.readdirSync(inputDir)) {
        try { fs.unlinkSync(path.join(inputDir, f)); } catch {}
      }
    }
  } catch {}

  runningContainers.delete(groupFolder);
}

/**
 * Get or start a persistent container for a group.
 * Returns the container entry, or null if startup failed.
 */
async function getOrStartContainer(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<PersistentContainer | null> {
  const existing = runningContainers.get(group.folder);

  // Check if existing container is still alive
  if (existing) {
    if (isContainerRunning(existing.containerId) && isHeartbeatAlive(group.folder)) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // Container died or heartbeat stale - clean up and restart
    logger.warn(
      { groupFolder: group.folder, containerId: existing.containerId.slice(0, 12) },
      'Persistent container is dead/stale, restarting',
    );
    killContainer(group.folder, 'dead/stale');
  }

  // Start a new persistent container
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, isMain);
  const containerArgs = buildPersistentContainerArgs(mounts);

  logger.info(
    {
      group: group.name,
      mountCount: mounts.length,
      isMain,
      mode: 'persistent',
    },
    'Starting persistent container',
  );

  logger.debug(
    {
      group: group.name,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration (persistent)',
  );

  let containerId: string;
  try {
    // docker run -d prints the container ID
    containerId = execSync(`docker ${containerArgs.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch (err) {
    logger.error(
      { group: group.name, error: err },
      'Failed to start persistent container',
    );
    return null;
  }

  logger.info(
    { group: group.name, containerId: containerId.slice(0, 12) },
    'Persistent container started, waiting for heartbeat',
  );

  // Wait for the agent to signal readiness via heartbeat
  const ready = await waitForHeartbeat(group.folder, containerId);
  if (!ready) {
    // Dump container logs for debugging
    try {
      const logs = execSync(`docker logs --tail 50 ${containerId} 2>&1`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      logger.error(
        { group: group.name, containerId: containerId.slice(0, 12), logs },
        'Container failed to become ready, dumping logs',
      );
    } catch {}

    // Kill the failed container
    try { execSync(`docker rm -f ${containerId}`, { timeout: 5000 }); } catch {}
    return null;
  }

  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  const entry: PersistentContainer = {
    containerId,
    groupFolder: group.folder,
    lastUsed: Date.now(),
    ipcDir: groupIpcDir,
  };

  runningContainers.set(group.folder, entry);

  logger.info(
    { group: group.name, containerId: containerId.slice(0, 12) },
    'Persistent container ready',
  );

  return entry;
}

/**
 * Send input to a persistent container via file and wait for output.
 */
async function sendToPersistentContainer(
  container: PersistentContainer,
  input: ContainerInput,
  timeout: number,
): Promise<ContainerOutput> {
  const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputDir = path.join(container.ipcDir, 'agent-input');
  const outputDir = path.join(container.ipcDir, 'agent-output');
  const inputFile = path.join(inputDir, `req-${timestamp}.json`);
  const outputFile = path.join(outputDir, `res-${timestamp}.json`);

  // Atomic write of input file
  const tmpFile = `${inputFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(input));
  fs.renameSync(tmpFile, inputFile);

  logger.debug(
    { groupFolder: container.groupFolder, requestId: timestamp },
    'Wrote input file to persistent container',
  );

  // Poll for output file
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (fs.existsSync(outputFile)) {
      try {
        const raw = fs.readFileSync(outputFile, 'utf-8');
        const output: ContainerOutput = JSON.parse(raw);

        // Clean up output file
        try { fs.unlinkSync(outputFile); } catch {}

        return output;
      } catch (err) {
        logger.error(
          { outputFile, error: err },
          'Failed to parse output file from persistent container',
        );
        try { fs.unlinkSync(outputFile); } catch {}
        return {
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Check if container is still alive while waiting
    if (!isContainerRunning(container.containerId)) {
      // Clean up stale input file if it still exists
      try { fs.unlinkSync(inputFile); } catch {}
      return {
        status: 'error',
        result: null,
        error: 'Persistent container died while processing request',
      };
    }

    await new Promise(resolve => setTimeout(resolve, OUTPUT_POLL_INTERVAL));
  }

  // Timeout - clean up input file if it wasn't consumed
  try { fs.unlinkSync(inputFile); } catch {}

  return {
    status: 'error',
    result: null,
    error: `Persistent container request timed out after ${timeout}ms`,
  };
}

/**
 * Run a request through a persistent container.
 * Falls back to one-shot mode on persistent failure.
 */
async function runPersistentContainer(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const container = await getOrStartContainer(group, input.isMain);
  if (!container) {
    logger.warn(
      { group: group.name },
      'Failed to start persistent container, falling back to one-shot',
    );
    return runOneShotContainer(group, input);
  }

  const timeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const output = await sendToPersistentContainer(container, input, timeout);
  const duration = Date.now() - startTime;

  // Log the result
  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `container-${logTimestamp}.log`);
  const isVerbose =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  const logLines = [
    `=== Container Run Log (persistent) ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${group.name}`,
    `Container ID: ${container.containerId.slice(0, 12)}`,
    `IsMain: ${input.isMain}`,
    `Duration: ${duration}ms`,
    `Status: ${output.status}`,
    ``,
  ];

  if (isVerbose) {
    logLines.push(
      `=== Input ===`,
      JSON.stringify(input, null, 2),
      ``,
    );
  } else {
    logLines.push(
      `=== Input Summary ===`,
      `Prompt length: ${input.prompt.length} chars`,
      `Session ID: ${input.sessionId || 'new'}`,
      ``,
    );
  }

  if (output.error) {
    logLines.push(`=== Error ===`, output.error, ``);
  }

  fs.writeFileSync(logFile, logLines.join('\n'));

  logger.info(
    {
      group: group.name,
      duration,
      status: output.status,
      hasResult: !!output.result,
      containerId: container.containerId.slice(0, 12),
      mode: 'persistent',
    },
    'Container completed (persistent)',
  );

  // If the container died during processing, remove it from tracking
  if (output.error?.includes('died while processing') || output.error?.includes('timed out')) {
    killContainer(group.folder, output.error);
  }

  return output;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a container agent for the given group and input.
 * Uses persistent mode by default, falls back to one-shot if needed.
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  if (FORCE_ONESHOT) {
    return runOneShotContainer(group, input);
  }
  return runPersistentContainer(group, input);
}

/**
 * Start the idle container cleanup timer.
 * Should be called once at application startup.
 */
export function startContainerIdleCleanup(): void {
  if (idleCleanupTimer) return;

  idleCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [groupFolder, container] of runningContainers) {
      const idleTime = now - container.lastUsed;
      if (idleTime > CONTAINER_IDLE_TIMEOUT) {
        killContainer(groupFolder, `idle for ${Math.round(idleTime / 1000)}s`);
      } else if (!isContainerRunning(container.containerId)) {
        // Container died on its own
        killContainer(groupFolder, 'container exited unexpectedly');
      }
    }
  }, IDLE_CHECK_INTERVAL);

  logger.info(
    {
      idleTimeout: `${CONTAINER_IDLE_TIMEOUT / 1000}s`,
      checkInterval: `${IDLE_CHECK_INTERVAL / 1000}s`,
    },
    'Container idle cleanup started',
  );
}

/**
 * Kill all running persistent containers.
 * Should be called on graceful shutdown.
 */
export function killAllContainers(): void {
  if (idleCleanupTimer) {
    clearInterval(idleCleanupTimer);
    idleCleanupTimer = null;
  }

  const count = runningContainers.size;
  if (count === 0) return;

  logger.info({ count }, 'Killing all persistent containers');

  for (const groupFolder of [...runningContainers.keys()]) {
    killContainer(groupFolder, 'application shutdown');
  }
}

/**
 * Get status of all running persistent containers.
 * Useful for debugging.
 */
export function getContainerStatus(): Array<{
  groupFolder: string;
  containerId: string;
  lastUsed: string;
  idleSeconds: number;
  running: boolean;
}> {
  const now = Date.now();
  return [...runningContainers.entries()].map(([groupFolder, c]) => ({
    groupFolder,
    containerId: c.containerId.slice(0, 12),
    lastUsed: new Date(c.lastUsed).toISOString(),
    idleSeconds: Math.round((now - c.lastUsed) / 1000),
    running: isContainerRunning(c.containerId),
  }));
}

// ─── IPC Helpers (unchanged) ─────────────────────────────────────────────────

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
