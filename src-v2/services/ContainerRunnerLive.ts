/**
 * ContainerRunnerLive — manages agent container lifecycle.
 * Dual mode: persistent (default) + one-shot (NANOCLAW_ONESHOT=1 or fallback).
 *
 * Port of src/container-runner.ts (v1).
 */

import fs from 'fs';
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
  InterruptResult,
} from './ContainerRunner.js';
import type { ContainerInput, ContainerOutput } from '../schemas/ContainerIO.js';
import type { VolumeMount } from './Docker.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const CONTAINER_IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const HEARTBEAT_WAIT_TIMEOUT = 30_000;
const HEARTBEAT_POLL_INTERVAL = 300;
const HEARTBEAT_STALE_THRESHOLD = 30_000;

const FORCE_ONESHOT = process.env.NANOCLAW_ONESHOT === '1';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PersistentContainer {
  readonly containerId: string;
  readonly groupFolder: string;
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

/** Map any error into ContainerError with a groupFolder context */
function toContainerError(groupFolder: string) {
  return (err: unknown) =>
    new ContainerError({
      message: err instanceof Error ? err.message : String(err),
      groupFolder,
    });
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
    ): Effect.Effect<ContainerOutput, ContainerError | ContainerTimeoutError> =>
      Effect.gen(function* () {
        const containerName = getOneShotContainerName(input.groupFolder);

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
    ): Effect.Effect<PersistentContainer | null, ContainerError> =>
      Effect.gen(function* () {
        const containers = yield* SynchronizedRef.get(persistentContainers);
        const existing = containers[input.groupFolder];

        if (existing) {
          const alive = yield* docker
            .isContainerRunning(existing.containerId)
            .pipe(
              Effect.mapError(toContainerError(input.groupFolder)),
              Effect.catchAll(() => Effect.succeed(false)),
            );

          if (alive && isHeartbeatAlive(config.dataDir, input.groupFolder)) {
            existing.lastActivity = Date.now();
            return existing;
          }
          yield* docker.remove(existing.containerId).pipe(Effect.ignore);
          yield* SynchronizedRef.update(persistentContainers, (c) => {
            const { [input.groupFolder]: _, ...rest } = c;
            return rest;
          });
        }

        fs.mkdirSync(path.join(config.groupsDir, input.groupFolder), {
          recursive: true,
        });

        const containerName = getPersistentContainerName(input.groupFolder);
        yield* docker.remove(containerName).pipe(Effect.ignore);

        yield* docker
          .run({
            name: containerName,
            image: config.containerImage,
            detached: true,
            mounts,
            env: {
              NANOCLAW_PERSISTENT: '1',
              NANOCLAW_AGENT_VERSION: config.containerAgentVersion,
            },
            labels: {
              'com.nanoclaw.app': 'nanoclaw',
              'com.nanoclaw.role': 'agent',
              'com.nanoclaw.group': sanitizeDockerNamePart(input.groupFolder),
            },
          })
          .pipe(Effect.mapError(toContainerError(input.groupFolder)));

        // Wait for heartbeat
        const ready = yield* Effect.tryPromise({
          try: async () => {
            const deadline = Date.now() + HEARTBEAT_WAIT_TIMEOUT;
            while (Date.now() < deadline) {
              if (isHeartbeatAlive(config.dataDir, input.groupFolder)) {
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
          yield* docker.remove(containerName).pipe(Effect.ignore);
          return null;
        }

        const groupIpcDir = path.join(config.dataDir, 'ipc', input.groupFolder);
        const entry: PersistentContainer = {
          containerId: containerName,
          groupFolder: input.groupFolder,
          lastActivity: Date.now(),
          ipcDir: groupIpcDir,
        };

        yield* SynchronizedRef.update(persistentContainers, (c) => ({
          ...c,
          [input.groupFolder]: entry,
        }));

        return entry;
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
      runAgent: (input, _handlers) =>
        Effect.gen(function* () {
          yield* Effect.log(
            `[ContainerRunner] runAgent for ${input.groupFolder} (provider=${input.provider})`,
          );

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
            `[ContainerRunner] Launching container (image=${config.containerImage}, oneshot=${FORCE_ONESHOT})`,
          );

          const result = yield* Effect.gen(function* () {
            if (FORCE_ONESHOT) {
              return yield* runOneShot(input, mounts);
            }

            // Try persistent mode
            const container = yield* getOrStartContainer(input, mounts);
            if (!container) {
              yield* Effect.log(`[ContainerRunner] Persistent mode failed, falling back to one-shot`);
              return yield* runOneShot(input, mounts);
            }

            // For persistent mode, send via one-shot protocol as fallback
            // Full RPC will be in Phase 5 GroupCoordinator
            return yield* runOneShot(input, mounts);
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
