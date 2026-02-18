/**
 * ContainerRunnerLive — manages agent container lifecycle.
 * Dual mode: persistent (default) + one-shot (NANOCLAW_ONESHOT=1 or fallback).
 *
 * Port of src/container-runner.ts (v1).
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { Effect, Fiber, Layer, Ref, Schedule, SynchronizedRef } from 'effect';

import { AppConfig } from '../config.js';
import {
  ContainerError,
  ContainerTimeoutError,
  ContainerInterruptedError,
} from '../errors.js';
import { Docker } from './Docker.js';
import { Credentials } from './Credentials.js';
import { ContainerRunner } from './ContainerRunner.js';
import type {
  ContainerRunnerService,
  HostRpcHandlers,
  InterruptResult,
} from './ContainerRunner.js';
import type { ContainerInput, ContainerOutput } from '../schemas/ContainerIO.js';
import type { RpcMessage, RpcRequestMessage } from '../schemas/RpcProtocol.js';
import type { VolumeMount } from './Docker.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const CONTAINER_IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const HEARTBEAT_WAIT_TIMEOUT = 30_000;
const HEARTBEAT_POLL_INTERVAL = 300;
const HEARTBEAT_STALE_THRESHOLD = 30_000;
const AGENT_RPC_SOCKET = 'agent.sock';
const PERSISTENT_RPC_PORT_BASE = (() => {
  const raw = Number.parseInt(process.env.NANOCLAW_RPC_BASE_PORT || '47000', 10);
  return Number.isFinite(raw) && raw >= 1025 && raw <= 64535 ? raw : 47000;
})();
const PERSISTENT_RPC_PORT_RANGE = 1000;

const FORCE_ONESHOT = process.env.NANOCLAW_ONESHOT === '1';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PersistentContainer {
  readonly containerId: string;
  readonly groupFolder: string;
  readonly rpcPort: number;
  lastActivity: number;
  readonly ipcDir: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeDockerNamePart(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'default';
}

function getPersistentContainerName(groupFolder: string): string {
  return `nanoclaw-agent-${sanitizeDockerNamePart(groupFolder)}`.slice(0, 63);
}

function getOneShotContainerName(groupFolder: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `nanoclaw-oneshot-${sanitizeDockerNamePart(groupFolder)}-${suffix}`.slice(0, 63);
}

function getPersistentRpcPort(groupFolder: string): number {
  let hash = 0;
  for (let i = 0; i < groupFolder.length; i++) {
    hash = ((hash * 31) + groupFolder.charCodeAt(i)) >>> 0;
  }
  return PERSISTENT_RPC_PORT_BASE + (hash % PERSISTENT_RPC_PORT_RANGE);
}

function isHeartbeatAlive(dataDir: string, groupFolder: string): boolean {
  const heartbeatPath = path.join(dataDir, 'ipc', groupFolder, 'agent-heartbeat');
  try {
    if (!fs.existsSync(heartbeatPath)) return false;
    const data = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
    return Date.now() - data.timestamp < HEARTBEAT_STALE_THRESHOLD;
  } catch {
    return false;
  }
}

function isRpcSocketReady(dataDir: string, groupFolder: string): boolean {
  return fs.existsSync(path.join(dataDir, 'ipc', groupFolder, AGENT_RPC_SOCKET));
}

function clearPersistentIpcArtifacts(dataDir: string, groupFolder: string): void {
  const groupIpcDir = path.join(dataDir, 'ipc', groupFolder);
  const heartbeatPath = path.join(groupIpcDir, 'agent-heartbeat');
  const socketPath = path.join(groupIpcDir, AGENT_RPC_SOCKET);
  try {
    if (fs.existsSync(heartbeatPath)) fs.unlinkSync(heartbeatPath);
  } catch {
    // Best effort cleanup.
  }
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // Best effort cleanup.
  }
}

async function canConnectRpcSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    const socket = net.createConnection({ path: socketPath });
    socket.setTimeout(750);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function canConnectTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(750);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function canConnectPersistentEndpoint(
  dataDir: string,
  groupFolder: string,
  rpcPort: number,
): Promise<boolean> {
  if (await canConnectTcpPort(rpcPort)) return true;
  const socketPath = path.join(dataDir, 'ipc', groupFolder, AGENT_RPC_SOCKET);
  if (!fs.existsSync(socketPath)) return false;
  return canConnectRpcSocket(socketPath);
}

function serializeRpcMessage(msg: RpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

function parseRpcLines(
  chunk: string,
  buffer: string,
): { messages: RpcMessage[]; buffer: string } {
  const messages: RpcMessage[] = [];
  const data = buffer + chunk;
  const lines = data.split('\n');
  const nextBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as RpcMessage);
    } catch {
      // Ignore malformed lines and keep transport alive.
    }
  }

  return { messages, buffer: nextBuffer };
}

function isContainerOutput(value: unknown): value is ContainerOutput {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.status === 'success' ||
      obj.status === 'error' ||
      obj.status === 'interrupted') &&
    'result' in obj
  );
}

/** Map any error into ContainerError with a groupFolder context */
function toContainerError(groupFolder: string) {
  return (err: unknown) =>
    new ContainerError({
      message: err instanceof Error ? err.message : String(err),
      groupFolder,
    });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function shortContainerId(raw: string): string {
  return raw.trim().replace(/^sha256:/, '').slice(0, 12);
}

function buildMounts(
  config: {
    projectRoot: string;
    groupsDir: string;
    dataDir: string;
    mainGroupFolder: string;
  },
  groupFolder: string,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  if (isMain) {
    mounts.push({
      hostPath: config.projectRoot,
      containerPath: '/workspace/project',
    });
  }

  mounts.push({
    hostPath: path.join(config.groupsDir, groupFolder),
    containerPath: '/workspace/group',
  });

  if (!isMain) {
    const globalDir = path.join(config.groupsDir, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // IPC directory
  const groupIpcDir = path.join(config.dataDir, 'ipc', groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'agent-input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'agent-output'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'status'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
  });

  // Env directory
  const envDir = path.join(config.dataDir, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  mounts.push({
    hostPath: envDir,
    containerPath: '/workspace/env-dir',
    readonly: true,
  });

  return mounts;
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const ContainerRunnerLive: Layer.Layer<
  ContainerRunner,
  never,
  Docker | Credentials | AppConfig
> = Layer.scoped(
  ContainerRunner,
  Effect.gen(function* () {
    const docker = yield* Docker;
    const credentials = yield* Credentials;
    const config = yield* AppConfig;

    // Track active persistent containers
    const persistentContainers = yield* SynchronizedRef.make<
      Record<string, PersistentContainer>
    >({});

    // Track active requests for interrupt support
    const activeRequestGroups = yield* Ref.make<Set<string>>(new Set());

    // Image rebuild coalescing
    const rebuildingRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(
      null,
    );

    const readImageDiagnostics = (image: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const [sizeRaw, idRaw] = yield* Effect.all(
          [
            docker.inspect(image, '{{.Size}}').pipe(
              Effect.catchAll(() => Effect.succeed('')),
            ),
            docker.inspect(image, '{{.Id}}').pipe(
              Effect.catchAll(() => Effect.succeed('')),
            ),
          ],
          { concurrency: 'unbounded' },
        );

        const size = Number.parseInt(sizeRaw.trim(), 10);
        const sizeLabel =
          Number.isFinite(size) && size >= 0 ? formatBytes(size) : null;
        const id = idRaw.trim() ? shortContainerId(idRaw) : null;

        if (!sizeLabel && !id) return null;

        const details = [`image=${image}`];
        if (sizeLabel) details.push(`size=${sizeLabel}`);
        if (id) details.push(`id=${id}`);
        return `container image ready (${details.join(', ')})`;
      });

    // Write resolved credentials to env file for containers
    const writeEnvFile = (envVars: Record<string, string>) =>
      Effect.try({
        try: () => {
          const envDir = path.join(config.dataDir, 'env');
          fs.mkdirSync(envDir, { recursive: true });
          const lines = Object.entries(envVars).map(
            ([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`,
          );
          fs.writeFileSync(path.join(envDir, 'env'), lines.join('\n') + '\n');
        },
        catch: (err) =>
          new ContainerError({
            message: `Failed to write env file: ${err}`,
            groupFolder: '',
          }),
      });

    // ─── One-shot mode ────────────────────────────────────────────────────

    const runOneShot = (
      input: ContainerInput,
      mounts: VolumeMount[],
      handlers: {
        onEvent?: (
          evt: { readonly method: string; readonly params?: unknown },
        ) => Promise<void> | void;
      },
    ): Effect.Effect<ContainerOutput, ContainerError | ContainerTimeoutError> =>
      Effect.gen(function* () {
        const emitStatus = (text: string) =>
          handlers.onEvent
            ? Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    handlers.onEvent!({ method: 'container_state', params: { text } }),
                  ),
                catch: () => undefined,
            }).pipe(Effect.catchAll(() => Effect.void))
            : Effect.void;

        const containerName = getOneShotContainerName(input.groupFolder);

        yield* emitStatus('container loading');

        const proc = yield* docker
          .run({
            name: containerName,
            image: config.containerImage,
            interactive: true,
            remove: true,
            mounts,
            env: { NANOCLAW_AGENT_VERSION: config.containerAgentVersion },
            labels: {
              'com.nanoclaw.app': 'nanoclaw',
              'com.nanoclaw.role': 'agent',
              'com.nanoclaw.group': sanitizeDockerNamePart(input.groupFolder),
            },
          })
          .pipe(Effect.mapError(toContainerError(input.groupFolder)));

        // Write input to stdin
        yield* Effect.try({
          try: () => {
            proc.stdin.write(JSON.stringify(input));
            proc.stdin.end();
          },
          catch: (err) =>
            new ContainerError({
              message: `Failed to write stdin: ${err}`,
              groupFolder: input.groupFolder,
            }),
        });

        // Collect stdout/stderr with timeout
        yield* emitStatus('container waiting');
        const result = yield* Effect.tryPromise({
          try: () =>
            new Promise<ContainerOutput>((resolve) => {
              let stdout = '';
              let stderr = '';
              const maxSize = config.containerMaxOutputSize;

              proc.stdout.on('data', (chunk: Buffer) => {
                if (stdout.length < maxSize) {
                  stdout += chunk.toString();
                }
              });

              proc.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < maxSize) {
                  stderr += chunk.toString();
                }
              });

              const timeout = setTimeout(() => {
                proc.stdout.destroy();
                proc.stderr.destroy();
                resolve({
                  status: 'error',
                  result: null,
                  error: `Container timed out after ${config.containerTimeout}ms`,
                });
              }, config.containerTimeout);

              proc.stdout.on('end', () => {
                clearTimeout(timeout);

                const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
                const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

                let jsonLine: string;
                if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                  jsonLine = stdout
                    .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
                    .trim();
                } else {
                  const lines = stdout.trim().split('\n');
                  jsonLine = lines[lines.length - 1];
                }

                try {
                  const output = JSON.parse(jsonLine) as ContainerOutput;
                  resolve(output);
                } catch {
                  resolve({
                    status: 'error',
                    result: null,
                    error: `Failed to parse container output: ${stderr.slice(-200)}`,
                  });
                }
              });

              proc.stdout.on('error', () => {
                clearTimeout(timeout);
                resolve({
                  status: 'error',
                  result: null,
                  error: `Container stdout error: ${stderr.slice(-200)}`,
                });
              });
            }),
          catch: (err) =>
            new ContainerError({
              message: `One-shot container failed: ${err}`,
              groupFolder: input.groupFolder,
            }),
        });

        return result;
      });

    // ─── Persistent mode ──────────────────────────────────────────────────

    const getOrStartContainer = (
      input: ContainerInput,
      mounts: VolumeMount[],
      emitStatus?: (text: string) => Effect.Effect<void>,
    ): Effect.Effect<PersistentContainer | null, ContainerError> =>
      Effect.gen(function* () {
        const containers = yield* SynchronizedRef.get(persistentContainers);
        const existing = containers[input.groupFolder];
        const rpcPort = getPersistentRpcPort(input.groupFolder);

        if (existing) {
          const alive = yield* docker
            .isContainerRunning(existing.containerId)
            .pipe(
              Effect.mapError(toContainerError(input.groupFolder)),
              Effect.catchAll(() => Effect.succeed(false)),
            );

          const endpointReady = yield* Effect.tryPromise({
            try: () =>
              canConnectPersistentEndpoint(
                config.dataDir,
                input.groupFolder,
                existing.rpcPort,
              ),
            catch: (err) =>
              new ContainerError({
                message: `Persistent endpoint check failed: ${err}`,
                groupFolder: input.groupFolder,
              }),
          });

          if (alive && isHeartbeatAlive(config.dataDir, input.groupFolder) && endpointReady) {
            if (emitStatus) {
              yield* emitStatus('container ready (warm start)');
            }
            existing.lastActivity = Date.now();
            return existing;
          }
          yield* docker.remove(existing.containerId).pipe(Effect.ignore);
          yield* Effect.sync(() =>
            clearPersistentIpcArtifacts(config.dataDir, input.groupFolder),
          );
          yield* SynchronizedRef.update(persistentContainers, (c) => {
            const { [input.groupFolder]: _, ...rest } = c;
            return rest;
          });
        }

        if (emitStatus) {
          yield* emitStatus('container loading (persistent)');
        }

        fs.mkdirSync(path.join(config.groupsDir, input.groupFolder), {
          recursive: true,
        });

        const containerName = getPersistentContainerName(input.groupFolder);
        yield* docker.remove(containerName).pipe(Effect.ignore);
        yield* Effect.sync(() =>
          clearPersistentIpcArtifacts(config.dataDir, input.groupFolder),
        );

        yield* docker
          .run({
            name: containerName,
            image: config.containerImage,
            detached: true,
            mounts,
            env: {
              NANOCLAW_PERSISTENT: '1',
              NANOCLAW_AGENT_VERSION: config.containerAgentVersion,
              NANOCLAW_RPC_TCP_PORT: String(rpcPort),
              NANOCLAW_RPC_TCP_HOST: '0.0.0.0',
            },
            ports: [{ host: rpcPort, container: rpcPort }],
            labels: {
              'com.nanoclaw.app': 'nanoclaw',
              'com.nanoclaw.role': 'agent',
              'com.nanoclaw.group': sanitizeDockerNamePart(input.groupFolder),
            },
          })
          .pipe(Effect.mapError(toContainerError(input.groupFolder)));

        if (emitStatus) {
          yield* emitStatus('container booting (waiting for heartbeat)');
        }

        // Wait for heartbeat
        const ready = yield* Effect.tryPromise({
          try: async () => {
            const deadline = Date.now() + HEARTBEAT_WAIT_TIMEOUT;
            while (Date.now() < deadline) {
              const running = await Effect.runPromise(
                docker.isContainerRunning(containerName).pipe(
                  Effect.catchAll(() => Effect.succeed(false)),
                ),
              );
              if (!running) {
                return false;
              }

              if (isHeartbeatAlive(config.dataDir, input.groupFolder) && (
                await canConnectPersistentEndpoint(
                  config.dataDir,
                  input.groupFolder,
                  rpcPort,
                )
              )) {
                return true;
              }
              await new Promise((r) => setTimeout(r, HEARTBEAT_POLL_INTERVAL));
            }
            return false;
          },
          catch: (err) =>
            new ContainerError({
              message: `Heartbeat wait failed: ${err}`,
              groupFolder: input.groupFolder,
            }),
        });

        if (!ready) {
          if (emitStatus) {
            yield* emitStatus('container startup timeout (falling back)');
          }
          yield* docker.remove(containerName).pipe(Effect.ignore);
          yield* Effect.sync(() =>
            clearPersistentIpcArtifacts(config.dataDir, input.groupFolder),
          );
          return null;
        }

        const groupIpcDir = path.join(config.dataDir, 'ipc', input.groupFolder);
        const entry: PersistentContainer = {
          containerId: containerName,
          groupFolder: input.groupFolder,
          rpcPort,
          lastActivity: Date.now(),
          ipcDir: groupIpcDir,
        };

        yield* SynchronizedRef.update(persistentContainers, (c) => ({
          ...c,
          [input.groupFolder]: entry,
        }));

        if (emitStatus) {
          yield* emitStatus('container ready (persistent)');
        }

        return entry;
      });

    const sendToPersistentContainer = (
      input: ContainerInput,
      container: PersistentContainer,
      handlers: HostRpcHandlers,
    ): Effect.Effect<ContainerOutput, ContainerError> =>
      Effect.tryPromise({
        try: () =>
          new Promise<ContainerOutput>((resolve) => {
            const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const requestId = `run-${runId}`;
            let settled = false;
            let buffer = '';

            const finish = (output: ContainerOutput): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              try {
                socket.destroy();
              } catch {
                // Best effort close.
              }
              resolve(output);
            };

            const socket = net.createConnection({
              host: '127.0.0.1',
              port: container.rpcPort,
            });

            const timer = setTimeout(() => {
              finish({
                status: 'error',
                result: null,
                error: `Persistent container request timed out after ${config.containerTimeout}ms`,
              });
            }, config.containerTimeout);

            socket.on('connect', () => {
              const msg: RpcRequestMessage = {
                type: 'request',
                id: requestId,
                method: 'run_query',
                params: input,
              };
              socket.write(serializeRpcMessage(msg));
            });

            socket.on('data', (chunk: Buffer) => {
              const parsed = parseRpcLines(chunk.toString('utf8'), buffer);
              buffer = parsed.buffer;

              for (const msg of parsed.messages) {
                if (msg.type === 'response' && msg.id === requestId) {
                  if (msg.error) {
                    finish({
                      status: 'error',
                      result: null,
                      error: msg.error,
                    });
                    return;
                  }

                  if (!isContainerOutput(msg.result)) {
                    finish({
                      status: 'error',
                      result: null,
                      error: 'Invalid run_query response from container',
                    });
                    return;
                  }

                  finish(msg.result);
                  return;
                }

                if (msg.type === 'request') {
                  if (!handlers.onRequest) {
                    const errResponse: RpcMessage = {
                      type: 'response',
                      id: msg.id,
                      error: `No host handler registered for method: ${msg.method}`,
                    };
                    socket.write(serializeRpcMessage(errResponse));
                    continue;
                  }

                  void Promise.resolve(
                    handlers.onRequest({ method: msg.method, params: msg.params }),
                  )
                    .then((result) => {
                      const okResponse: RpcMessage = {
                        type: 'response',
                        id: msg.id,
                        result: result ?? null,
                      };
                      try {
                        socket.write(serializeRpcMessage(okResponse));
                      } catch {
                        // Ignore if socket already closed.
                      }
                    })
                    .catch((err) => {
                      const errResponse: RpcMessage = {
                        type: 'response',
                        id: msg.id,
                        error: err instanceof Error ? err.message : String(err),
                      };
                      try {
                        socket.write(serializeRpcMessage(errResponse));
                      } catch {
                        // Ignore if socket already closed.
                      }
                    });
                  continue;
                }

                if (msg.type === 'event' && handlers.onEvent) {
                  void Promise.resolve(
                    handlers.onEvent({ method: msg.method, params: msg.params }),
                  ).catch(() => undefined);
                }
              }
            });

            socket.on('error', (err) => {
              if (!isHeartbeatAlive(config.dataDir, input.groupFolder)) {
                finish({
                  status: 'error',
                  result: null,
                  error: 'Persistent container died while processing request',
                });
                return;
              }
              finish({
                status: 'error',
                result: null,
                error: `Persistent socket error (tcp:${container.rpcPort}): ${err.message}`,
              });
            });

            socket.on('close', () => {
              if (!settled) {
                finish({
                  status: 'error',
                  result: null,
                  error: 'Persistent RPC connection closed before response',
                });
              }
            });
          }),
        catch: (err) =>
          new ContainerError({
            message: `Persistent container request failed: ${err instanceof Error ? err.message : String(err)}`,
            groupFolder: input.groupFolder,
          }),
      });

    // ─── Idle cleanup fiber ─────────────────────────────────────────────

    const idleCleanupFiber = yield* Effect.fork(
      Effect.gen(function* () {
        const containers = yield* SynchronizedRef.get(persistentContainers);
        const now = Date.now();
        for (const [folder, info] of Object.entries(containers)) {
          const idleTime = now - info.lastActivity;
          const alive = yield* docker
            .isContainerRunning(info.containerId)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));

          if (!alive || idleTime > CONTAINER_IDLE_TIMEOUT) {
            yield* docker.remove(info.containerId).pipe(Effect.ignore);
            yield* SynchronizedRef.update(persistentContainers, (c) => {
              const { [folder]: _, ...rest } = c;
              return rest;
            });
          }
        }
      }).pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(`${IDLE_CHECK_INTERVAL_MS} millis`)),
      ),
    );

    // ─── Orphan cleanup on startup ──────────────────────────────────────

    yield* docker
      .killAllWithLabel('com.nanoclaw.role=agent')
      .pipe(Effect.ignore);

    // ─── Image self-heal ────────────────────────────────────────────────

    const ensureImage: ContainerRunnerService['ensureImage'] = Effect.gen(
      function* () {
        const exists = yield* docker
          .imageExists(config.containerImage)
          .pipe(Effect.mapError(toContainerError('')));
        if (exists) return;

        // Coalesce concurrent rebuilds
        const existing = yield* Ref.get(rebuildingRef);
        if (existing) {
          yield* Fiber.join(existing);
          return;
        }

        const buildScript = path.join(
          config.projectRoot,
          'container',
          'build.sh',
        );
        const fiber = yield* Effect.fork(
          docker.rebuildImage(buildScript).pipe(
            Effect.tap(() => Ref.set(rebuildingRef, null)),
            Effect.catchAll(() =>
              Ref.set(rebuildingRef, null).pipe(Effect.asVoid),
            ),
          ),
        );
        yield* Ref.set(rebuildingRef, fiber);
        yield* Fiber.join(fiber);
      },
    );

    // ─── Scope finalizer ────────────────────────────────────────────────

    yield* Effect.addFinalizer(() =>
      Effect.all([
        Fiber.interrupt(idleCleanupFiber),
        SynchronizedRef.get(persistentContainers).pipe(
          Effect.flatMap((containers) =>
            Effect.all(
              Object.values(containers).map((c) =>
                docker.remove(c.containerId).pipe(Effect.ignore),
              ),
            ),
          ),
        ),
      ]).pipe(Effect.ignore),
    );

    // ─── Service implementation ─────────────────────────────────────────

    const service: ContainerRunnerService = {
      runAgent: (input, handlers) =>
        Effect.gen(function* () {
          yield* Effect.log(
            `[ContainerRunner] runAgent for ${input.groupFolder} (provider=${input.provider})`,
          );

          const emitStatus = (text: string) =>
            handlers.onEvent
              ? Effect.tryPromise({
                  try: () =>
                    Promise.resolve(
                      handlers.onEvent!({
                        method: 'container_state',
                        params: { text },
                      }),
                    ),
                  catch: () => undefined,
                }).pipe(Effect.catchAll(() => Effect.void))
              : Effect.void;

          // Resolve + refresh credentials
          const creds = yield* credentials.resolve.pipe(
            Effect.mapError(toContainerError(input.groupFolder)),
          );
          yield* credentials.refreshOAuth.pipe(Effect.ignore);
          yield* writeEnvFile(creds.envVars);
          yield* Effect.log(`[ContainerRunner] Credentials resolved, env written`);

          // Mark as active
          yield* Ref.update(activeRequestGroups, (s) => {
            const next = new Set(s);
            next.add(input.groupFolder);
            return next;
          });

          const mounts = buildMounts(
            config,
            input.groupFolder,
            input.isMain,
          );

          yield* Effect.log(
            `[ContainerRunner] Launching container (image=${config.containerImage}, agent=v${config.containerAgentVersion}, oneshot=${FORCE_ONESHOT})`,
          );
          yield* emitStatus('container preparing');

          const imageExists = yield* docker
            .imageExists(config.containerImage)
            .pipe(Effect.mapError(toContainerError(input.groupFolder)));
          if (!imageExists) {
            yield* emitStatus('container building');
            yield* ensureImage;
          }

          const imageDiagnostics = yield* readImageDiagnostics(
            config.containerImage,
          );
          if (imageDiagnostics) {
            yield* emitStatus(imageDiagnostics);
          }

          const supportsPersistent = config.containerAgentVersion === '2';
          if (!supportsPersistent && !FORCE_ONESHOT) {
            const reason =
              `persistent mode disabled for agent v${config.containerAgentVersion}; set NANOCLAW_AGENT_VERSION=2`;
            yield* Effect.log(`[ContainerRunner] ${reason}`);
            yield* emitStatus(reason);
          }

          const result = yield* Effect.gen(function* () {
            if (FORCE_ONESHOT || !supportsPersistent) {
              return yield* runOneShot(input, mounts, handlers);
            }

            // Try persistent mode
            const container = yield* getOrStartContainer(input, mounts, emitStatus);
            if (!container) {
              yield* Effect.log(`[ContainerRunner] Persistent mode failed, falling back to one-shot`);
              return yield* runOneShot(input, mounts, handlers);
            }

            const output = yield* sendToPersistentContainer(
              input,
              container,
              handlers,
            );
            container.lastActivity = Date.now();

            const persistentTransportFailed =
              output.status === 'error' &&
              !!output.error &&
              (
                output.error.includes('died while processing') ||
                output.error.includes('timed out') ||
                output.error.includes('socket error') ||
                output.error.includes('connection closed')
              );

            if (persistentTransportFailed) {
              yield* docker.remove(container.containerId).pipe(Effect.ignore);
              yield* Effect.sync(() =>
                clearPersistentIpcArtifacts(config.dataDir, input.groupFolder),
              );
              yield* SynchronizedRef.update(persistentContainers, (c) => {
                const { [input.groupFolder]: _, ...rest } = c;
                return rest;
              });
              yield* Effect.log(
                `[ContainerRunner] Persistent transport failed (${output.error}), falling back to one-shot`,
              );
              return yield* runOneShot(input, mounts, handlers);
            }

            return output;
          });

          yield* Effect.log(
            `[ContainerRunner] Container finished: status=${result.status}${result.error ? ` error=${result.error.slice(0, 200)}` : ''}`,
          );

          // Mark as inactive
          yield* Ref.update(activeRequestGroups, (s) => {
            const next = new Set(s);
            next.delete(input.groupFolder);
            return next;
          });

          return result;
        }),

      interrupt: (groupFolder) =>
        Effect.gen(function* () {
          // Write cancel file
          const cancelPath = path.join(
            config.dataDir,
            'ipc',
            groupFolder,
            'cancel',
          );
          yield* Effect.try({
            try: () => {
              fs.mkdirSync(path.dirname(cancelPath), { recursive: true });
              fs.writeFileSync(
                cancelPath,
                JSON.stringify({
                  timestamp: Date.now(),
                  reason: 'user_interrupt',
                }),
              );
            },
            catch: (err) =>
              new ContainerError({
                message: `Failed to write cancel file: ${err}`,
                groupFolder,
              }),
          });

          // Escalate: SIGTERM after 5s grace period
          yield* Effect.sleep('5 seconds');

          const containers =
            yield* SynchronizedRef.get(persistentContainers);
          const container = containers[groupFolder];
          if (container) {
            yield* docker.remove(container.containerId).pipe(Effect.ignore);
            yield* SynchronizedRef.update(persistentContainers, (c) => {
              const { [groupFolder]: _, ...rest } = c;
              return rest;
            });
          }

          return { interrupted: true } satisfies InterruptResult;
        }),

      hasActiveRequest: (groupFolder) =>
        Ref.get(activeRequestGroups).pipe(
          Effect.map((s) => s.has(groupFolder)),
        ),

      killAll: Effect.gen(function* () {
        yield* docker
          .killAllWithLabel('com.nanoclaw.role=agent')
          .pipe(Effect.mapError(toContainerError('')));
        yield* SynchronizedRef.set(persistentContainers, {});
      }),

      ensureImage,

      cleanupOrphans: docker
        .killAllWithLabel('com.nanoclaw.role=agent')
        .pipe(Effect.mapError(toContainerError(''))),
    };

    return service;
  }),
);
