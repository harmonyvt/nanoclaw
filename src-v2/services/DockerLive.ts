/**
 * DockerLive — wraps Docker CLI via Bun.spawn as an Effect Layer.
 *
 * Port of Docker CLI calls from src/container-runner.ts (v1).
 */

import { Readable, Writable } from 'stream';
import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import { DockerError, DockerImageBuildError } from '../errors.js';
import { Docker } from './Docker.js';
import type { DockerRunArgs, DockerProcess, DockerService } from './Docker.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const execDocker = (args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(['docker', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0)
        throw new Error(`docker ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
      return stdout;
    },
    catch: (err) =>
      new DockerError({
        message: `docker ${args[0]}: ${err instanceof Error ? err.message : String(err)}`,
      }),
  });

function buildRunArgs(args: DockerRunArgs): string[] {
  const dockerArgs: string[] = ['run'];

  if (args.detached) dockerArgs.push('-d');
  if (args.remove) dockerArgs.push('--rm');
  if (args.interactive) dockerArgs.push('-i');
  if (args.name) dockerArgs.push('--name', args.name);
  if (args.platform) dockerArgs.push('--platform', args.platform);
  if (args.shmSize) dockerArgs.push('--shm-size', args.shmSize);
  if (args.user) dockerArgs.push('--user', args.user);

  if (args.labels) {
    for (const [k, v] of Object.entries(args.labels)) {
      dockerArgs.push('--label', `${k}=${v}`);
    }
  }

  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      dockerArgs.push('-e', `${k}=${v}`);
    }
  }

  if (args.ports) {
    for (const p of args.ports) {
      dockerArgs.push('-p', `${p.host}:${p.container}`);
    }
  }

  for (const mount of args.mounts) {
    if (mount.readonly) {
      dockerArgs.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      dockerArgs.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  dockerArgs.push(args.image);

  return dockerArgs;
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const DockerLive: Layer.Layer<Docker, never, AppConfig> = Layer.effect(
  Docker,
  Effect.gen(function* () {
    yield* AppConfig;

    const service: DockerService = {
      isRunning: execDocker(['info']).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      ),

      imageExists: (image) =>
        execDocker(['image', 'inspect', image]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),

      pullImage: (image, platform) =>
        execDocker(
          platform
            ? ['pull', '--platform', platform, image]
            : ['pull', image],
        ).pipe(Effect.asVoid),

      rebuildImage: (buildScript) =>
        Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(['bash', buildScript], {
              stdout: 'pipe',
              stderr: 'pipe',
              cwd: buildScript.replace(/\/[^/]+$/, ''),
            });
            const exitCode = await proc.exited;
            if (exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text();
              throw new Error(`build.sh failed (exit ${exitCode}): ${stderr.slice(-500)}`);
            }
          },
          catch: (err) =>
            new DockerImageBuildError({
              image: 'nanoclaw-agent:latest',
              cause: err,
            }),
        }),

      run: (args) =>
        Effect.tryPromise({
          try: async () => {
            const dockerArgs = buildRunArgs(args);

            if (args.detached) {
              // For detached mode, use pipe and read the container ID
              const proc = Bun.spawn(['docker', ...dockerArgs], {
                stdout: 'pipe',
                stderr: 'pipe',
              });
              const exitCode = await proc.exited;
              const stdout = await new Response(proc.stdout).text();
              const stderr = await new Response(proc.stderr).text();
              if (exitCode !== 0)
                throw new Error(`docker run -d failed: ${stderr.trim()}`);

              const containerId = stdout.trim();
              return {
                stdin: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
                stdout: Readable.from([]),
                stderr: Readable.from([]),
                kill: (signal?: string) =>
                  execDocker(
                    signal
                      ? ['kill', `--signal=${signal}`, containerId]
                      : ['kill', containerId],
                  ).pipe(Effect.asVoid),
                waitForExit: Effect.succeed(0),
              } satisfies DockerProcess;
            }

            // Interactive mode — pipe stdin/stdout
            const proc = Bun.spawn(['docker', ...dockerArgs], {
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
            });

            const stdinStream = new Writable({
              write(chunk, _encoding, callback) {
                proc.stdin.write(chunk);
                callback();
              },
              final(callback) {
                proc.stdin.end();
                callback();
              },
            });

            const stdoutStream = Readable.fromWeb(
              proc.stdout as unknown as ReadableStream,
            );
            const stderrStream = Readable.fromWeb(
              proc.stderr as unknown as ReadableStream,
            );

            const containerName = args.name;

            return {
              stdin: stdinStream,
              stdout: stdoutStream,
              stderr: stderrStream,
              kill: (signal?: string) =>
                Effect.tryPromise({
                  try: async () => {
                    proc.kill(signal === 'SIGKILL' ? 9 : 15);
                    if (containerName) {
                      const rmProc = Bun.spawn(
                        ['docker', 'rm', '-f', containerName],
                        { stdout: 'pipe', stderr: 'pipe' },
                      );
                      await rmProc.exited;
                    }
                  },
                  catch: (err) =>
                    new DockerError({
                      message: `kill failed: ${err}`,
                    }),
                }),
              waitForExit: Effect.tryPromise({
                try: () => proc.exited,
                catch: (err) =>
                  new DockerError({
                    message: `waitForExit failed: ${err}`,
                  }),
              }),
            } satisfies DockerProcess;
          },
          catch: (err) =>
            new DockerError({
              message: `docker run failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
        }),

      exec: (container, command) =>
        execDocker(['exec', container, 'sh', '-c', command]).pipe(
          Effect.map((s) => s.trim()),
        ),

      stop: (container) =>
        execDocker(['stop', container]).pipe(Effect.asVoid),

      remove: (container) =>
        execDocker(['rm', '-f', container]).pipe(Effect.asVoid),

      inspect: (container, format) =>
        format
          ? execDocker(['inspect', '-f', format, container]).pipe(
              Effect.map((s) => s.trim()),
            )
          : execDocker(['inspect', container]),

      isContainerRunning: (name) =>
        execDocker([
          'inspect',
          '-f',
          '{{.State.Running}}',
          name,
        ]).pipe(
          Effect.map((s) => s.trim() === 'true'),
          Effect.catchAll(() => Effect.succeed(false)),
        ),

      killAllWithLabel: (label) =>
        Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(
              ['docker', 'ps', '-q', '--filter', `label=${label}`],
              { stdout: 'pipe', stderr: 'pipe' },
            );
            await proc.exited;
            const ids = (await new Response(proc.stdout).text())
              .trim()
              .split('\n')
              .filter(Boolean);
            for (const id of ids) {
              const killProc = Bun.spawn(['docker', 'kill', id], {
                stdout: 'pipe',
                stderr: 'pipe',
              });
              await killProc.exited;
            }
          },
          catch: (err) =>
            new DockerError({
              message: `killAllWithLabel failed: ${err}`,
            }),
        }),
    };

    return service;
  }),
);
