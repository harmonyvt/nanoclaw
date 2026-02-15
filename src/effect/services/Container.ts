/**
 * Effect service: Container Runner
 *
 * Wraps Docker container orchestration (persistent + one-shot modes)
 * into an Effect service with proper lifecycle management.
 */
import { Context, Effect, Layer } from 'effect';

import {
  cleanupOrphanPersistentContainers,
  ensureAgentImage,
  killAllContainers,
  runContainerAgent,
  startContainerIdleCleanup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  consumeGroupInterrupted,
  interruptContainer,
} from '../../container-runner.js';
import type {
  AvailableGroup,
  ContainerOutput,
  HostRpcRequest,
  HostRpcEvent,
} from '../../container-runner.js';
import type { RegisteredGroup } from '../../types.js';

export type { ContainerOutput };

export interface ContainerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  isSkillInvocation?: boolean;
  assistantName: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  enableThinking: boolean;
}

export interface ContainerRpcCallbacks {
  onRequest?: (req: HostRpcRequest) => Promise<unknown>;
  onEvent?: (evt: HostRpcEvent) => void;
}

export interface ContainerService {
  readonly ensureImage: () => Effect.Effect<boolean>;
  readonly cleanupOrphans: () => Effect.Effect<void>;
  readonly killAll: () => Effect.Effect<void>;
  readonly startIdleCleanup: () => Effect.Effect<void>;
  readonly runAgent: (
    group: RegisteredGroup,
    input: ContainerInput,
    callbacks?: ContainerRpcCallbacks,
  ) => Effect.Effect<ContainerOutput>;
  readonly writeTasksSnapshot: (
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
  ) => void;
  readonly writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  readonly consumeGroupInterrupted: (groupFolder: string) => boolean;
  readonly interruptContainer: (groupFolder: string) => { interrupted: boolean; message: string };
}

export class Container extends Context.Tag('nanoclaw/Container')<
  Container,
  ContainerService
>() {}

export const ContainerLive = Layer.scoped(
  Container,
  Effect.acquireRelease(
    Effect.sync(
      () =>
        ({
          ensureImage: () => Effect.promise(() => ensureAgentImage()),
          cleanupOrphans: () => Effect.sync(() => cleanupOrphanPersistentContainers()),
          killAll: () => Effect.sync(() => killAllContainers()),
          startIdleCleanup: () => Effect.sync(() => startContainerIdleCleanup()),
          runAgent: (group, input, callbacks) =>
            Effect.promise(() => runContainerAgent(group, input, callbacks)),
          writeTasksSnapshot,
          writeGroupsSnapshot,
          consumeGroupInterrupted,
          interruptContainer,
        }) satisfies ContainerService,
    ),
    () =>
      Effect.sync(() => {
        killAllContainers();
      }),
  ),
);
