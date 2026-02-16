/**
 * SandboxLive — CUA desktop sandbox lifecycle as a scoped Layer.
 *
 * Port of src/sandbox-manager.ts (v1).
 */

import { randomBytes } from 'crypto';
import { execSync, exec } from 'child_process';
import { Effect, Fiber, Layer, Ref, Schedule } from 'effect';

import { AppConfig } from '../config.js';
import { Docker } from './Docker.js';
import { SandboxError, SandboxStartError } from '../errors.js';
import { Sandbox } from './Sandbox.js';
import type { SandboxService, SandboxConnection } from './Sandbox.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateVncPassword(): string {
  return randomBytes(16).toString('base64url');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function execAsync(command: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const SandboxLive: Layer.Layer<Sandbox, never, Docker | AppConfig> =
  Layer.scoped(
    Sandbox,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const config = yield* AppConfig;

      const connectionRef = yield* Ref.make<SandboxConnection | null>(null);
      const lastActivityRef = yield* Ref.make<number>(0);
      const vncPasswordRef = yield* Ref.make<string | null>(null);

      const containerName = config.cuaSandboxContainerName;

      // ── Start sandbox container ─────────────────────────────────────

      const startContainer = Effect.gen(function* () {
        // Check if already running
        const running = yield* docker
          .isContainerRunning(containerName)
          .pipe(Effect.orElseSucceed(() => false));
        if (running) return;

        // Check if container exists but stopped (persist mode)
        if (config.cuaSandboxPersist) {
          const exists = yield* Effect.try({
            try: () => {
              execSync(`docker inspect ${containerName}`, { stdio: 'pipe' });
              return true;
            },
            catch: () => false,
          }).pipe(Effect.orElseSucceed(() => false));

          if (exists) {
            // Check image staleness
            const stale = yield* Effect.try({
              try: () => {
                const containerImageId = execSync(
                  `docker inspect --format '{{.Image}}' ${containerName}`,
                  { stdio: 'pipe' },
                )
                  .toString()
                  .trim();
                const currentImageId = execSync(
                  `docker inspect --format '{{.Id}}' ${config.cuaSandboxImage}`,
                  { stdio: 'pipe' },
                )
                  .toString()
                  .trim();
                return containerImageId !== currentImageId;
              },
              catch: () => true,
            }).pipe(Effect.orElseSucceed(() => true));

            if (stale) {
              yield* Effect.try({
                try: () =>
                  execSync(`docker rm -f ${containerName}`, {
                    stdio: 'pipe',
                  }),
                catch: () => undefined,
              }).pipe(Effect.ignore);
            } else {
              // Restart stopped container
              yield* Effect.try({
                try: () =>
                  execSync(`docker start ${containerName}`, {
                    stdio: 'pipe',
                  }),
                catch: (err) => new SandboxStartError({
                  message: `Failed to restart sandbox: ${err}`,
                  image: config.cuaSandboxImage,
                }),
              });
              return;
            }
          }
        } else {
          // Remove any existing container
          yield* Effect.try({
            try: () =>
              execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }

        // Create new container
        const vncPw = generateVncPassword();
        yield* Ref.set(vncPasswordRef, vncPw);

        const resolution = `${config.cuaSandboxScreenWidth}x${config.cuaSandboxScreenHeight}`;
        const args = [
          'docker', 'run', '-d',
          '--name', containerName,
          '--platform', config.cuaSandboxPlatform,
          '--shm-size', config.cuaSandboxShmSize,
          '-p', `${config.cuaSandboxCommandPort}:8000`,
          '-p', `${config.cuaSandboxVncPort}:5901`,
          '-p', `${config.cuaSandboxNovncPort}:6901`,
          '-e', `VNC_RESOLUTION=${resolution}`,
          '-e', `VNC_COL_DEPTH=${config.cuaSandboxScreenDepth}`,
          '-e', `SCREEN_WIDTH=${config.cuaSandboxScreenWidth}`,
          '-e', `SCREEN_HEIGHT=${config.cuaSandboxScreenHeight}`,
          '-e', `SCREEN_DEPTH=${config.cuaSandboxScreenDepth}`,
          '-e', `VNC_PW=${vncPw}`,
        ];

        if (config.cuaApiKey) {
          args.push('-e', `CUA_API_KEY=${config.cuaApiKey}`);
        }
        if (config.cuaSandboxPersist) {
          args.push('-v', `${config.cuaSandboxHomeVolume}:/home/cua`);
        }
        args.push(config.cuaSandboxImage);

        yield* Effect.try({
          try: () =>
            execSync(args.join(' '), { stdio: 'pipe' }),
          catch: (err) =>
            new SandboxStartError({
              message: `Failed to start sandbox: ${err}`,
              image: config.cuaSandboxImage,
            }),
        });
      });

      // ── Wait for command API ────────────────────────────────────────

      const waitForReady = Effect.retry(
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(
              `http://localhost:${config.cuaSandboxCommandPort}/health`,
              { signal: AbortSignal.timeout(3000) },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          },
          catch: () =>
            new SandboxStartError({
              message: 'Health check failed',
              image: config.cuaSandboxImage,
            }),
        }),
        Schedule.exponential('500 millis').pipe(
          Schedule.intersect(Schedule.recurs(20)),
        ),
      ).pipe(Effect.ignore);

      // ── Ensure (idempotent) ─────────────────────────────────────────

      const ensure = Effect.gen(function* () {
        const existing = yield* Ref.get(connectionRef);
        if (existing) {
          yield* Ref.set(lastActivityRef, Date.now());
          return existing;
        }

        yield* startContainer;
        yield* waitForReady;

        const conn: SandboxConnection = {
          containerName,
          commandUrl: `http://localhost:${config.cuaSandboxCommandPort}/cmd`,
          vncPort: config.cuaSandboxVncPort,
          novncPort: config.cuaSandboxNovncPort,
        };
        yield* Ref.set(connectionRef, conn);
        yield* Ref.set(lastActivityRef, Date.now());
        return conn;
      });

      // ── Stop ────────────────────────────────────────────────────────

      const stop = Effect.gen(function* () {
        const existing = yield* Ref.get(connectionRef);
        if (!existing) return;
        yield* docker.stop(containerName).pipe(Effect.ignore);
        if (!config.cuaSandboxPersist) {
          yield* docker.remove(containerName).pipe(Effect.ignore);
        }
        yield* Ref.set(connectionRef, null);
        yield* Ref.set(vncPasswordRef, null);
      });

      // ── VNC password rotation ───────────────────────────────────────

      const rotateVncPassword = Effect.gen(function* () {
        const running = yield* docker
          .isContainerRunning(containerName)
          .pipe(Effect.orElseSucceed(() => false));
        if (!running) return null;

        const newPassword = generateVncPassword();

        // Try rotation script first, then inline fallback
        const rotated = yield* Effect.try({
          try: () => {
            execSync(
              `docker exec ${containerName} /rotate-vnc-pw.sh ${shellQuote(newPassword)}`,
              { stdio: 'pipe', timeout: 5000 },
            );
            return true;
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));

        if (!rotated) {
          yield* Effect.try({
            try: () => {
              const cmd = [
                `x11vnc -storepasswd ${shellQuote(newPassword)} /tmp/vncpasswd 2>/dev/null`,
                'pkill -x x11vnc 2>/dev/null || true',
                'sleep 0.3',
                'x11vnc -display :99 -forever -shared -rfbport 5900 -rfbauth /tmp/vncpasswd &',
              ].join(' && ');
              execSync(
                `docker exec ${containerName} bash -c ${shellQuote(cmd)}`,
                { stdio: 'pipe', timeout: 10000 },
              );
            },
            catch: (err) =>
              new SandboxError({
                message: `VNC password rotation failed: ${err}`,
              }),
          });
        }

        yield* Ref.set(vncPasswordRef, newPassword);
        return newPassword;
      });

      // ── Reset ───────────────────────────────────────────────────────

      const reset = Effect.gen(function* () {
        yield* docker.stop(containerName).pipe(Effect.ignore);
        yield* docker.remove(containerName).pipe(Effect.ignore);
        yield* Ref.set(connectionRef, null);
        yield* Ref.set(vncPasswordRef, null);
      });

      const resetFull = Effect.gen(function* () {
        yield* reset;
        if (config.cuaSandboxPersist) {
          yield* Effect.try({
            try: () =>
              execSync(`docker volume rm ${config.cuaSandboxHomeVolume}`, {
                stdio: 'pipe',
                timeout: 5000,
              }),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      });

      // ── Idle watcher ────────────────────────────────────────────────

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const idleFiberRef = yield* Ref.make<Fiber.Fiber<any, any> | null>(null);

      const startIdleWatcher = Effect.gen(function* () {
        const existing = yield* Ref.get(idleFiberRef);
        if (existing) return; // already started

        const fiber = yield* Effect.fork(
          Effect.gen(function* () {
            const lastActivity = yield* Ref.get(lastActivityRef);
            if (
              lastActivity > 0 &&
              Date.now() - lastActivity > config.sandboxIdleTimeoutMs
            ) {
              const conn = yield* Ref.get(connectionRef);
              if (conn) {
                yield* Effect.log('Sandbox idle timeout reached, stopping');
                yield* stop;
                yield* Ref.set(lastActivityRef, 0);
              }
            }
          }).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.repeat(Schedule.fixed('60 seconds')),
            Effect.asVoid,
          ),
        );
        yield* Ref.set(idleFiberRef, fiber);
      });

      // ── Finalizer ──────────────────────────────────────────────────

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const idleFiber = yield* Ref.get(idleFiberRef);
          if (idleFiber) {
            yield* Fiber.interrupt(idleFiber).pipe(Effect.ignore);
          }
          yield* stop.pipe(Effect.ignore);
        }),
      );

      const service: SandboxService = {
        acquire: ensure,
        ensure,
        resetIdle: Ref.set(lastActivityRef, Date.now()),
        getVncPassword: Ref.get(vncPasswordRef),
        rotateVncPassword,
        reset,
        resetFull,
        startIdleWatcher,
      };

      return service;
    }),
  );
