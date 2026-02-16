/**
 * Docker service — wraps Docker CLI operations as an Effect Service.
 */

import { Context, Effect } from 'effect';
import type { Readable, Writable } from 'stream';
import type {
  DockerError,
  DockerNotRunningError,
  DockerImageMissingError,
  DockerImageBuildError,
} from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface VolumeMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readonly?: boolean;
}

export interface DockerRunArgs {
  readonly name?: string;
  readonly image: string;
  readonly detached?: boolean;
  readonly remove?: boolean;
  readonly interactive?: boolean;
  readonly mounts: ReadonlyArray<VolumeMount>;
  readonly env?: Record<string, string>;
  readonly ports?: ReadonlyArray<{ host: number; container: number }>;
  readonly platform?: string;
  readonly shmSize?: string;
  readonly labels?: Record<string, string>;
  readonly user?: string;
}

export interface DockerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: string) => Effect.Effect<void, DockerError>;
  readonly waitForExit: Effect.Effect<number, DockerError>;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface DockerService {
  readonly isRunning: Effect.Effect<boolean, DockerError>;

  readonly imageExists: (
    image: string,
  ) => Effect.Effect<boolean, DockerError>;

  readonly pullImage: (
    image: string,
    platform?: string,
  ) => Effect.Effect<void, DockerError>;

  readonly rebuildImage: (
    buildScript: string,
  ) => Effect.Effect<void, DockerImageBuildError>;

  readonly run: (
    args: DockerRunArgs,
  ) => Effect.Effect<DockerProcess, DockerError>;

  readonly exec: (
    container: string,
    command: string,
  ) => Effect.Effect<string, DockerError>;

  readonly stop: (container: string) => Effect.Effect<void, DockerError>;

  readonly remove: (container: string) => Effect.Effect<void, DockerError>;

  readonly inspect: (
    container: string,
    format?: string,
  ) => Effect.Effect<string, DockerError>;

  readonly isContainerRunning: (
    name: string,
  ) => Effect.Effect<boolean, DockerError>;

  readonly killAllWithLabel: (
    label: string,
  ) => Effect.Effect<void, DockerError>;
}

export class Docker extends Context.Tag('Docker')<Docker, DockerService>() {}
