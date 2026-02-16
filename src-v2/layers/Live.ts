/**
 * Production layer composition — assembles all service Live layers.
 *
 * Uses Layer.provide to satisfy dependencies bottom-up,
 * then Layer.mergeAll to expose all services.
 */

import { Layer } from 'effect';
import { AppConfig, AppConfigLive } from '../config.js';
import { Database } from '../services/Database.js';
import { Docker } from '../services/Docker.js';
import { Credentials } from '../services/Credentials.js';
import { Telegram } from '../services/Telegram.js';
import { ContainerRunner } from '../services/ContainerRunner.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { Scheduler } from '../services/Scheduler.js';
import { Sandbox } from '../services/Sandbox.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { TTS } from '../services/TTS.js';
import { Supermemory } from '../services/Supermemory.js';
import { Media } from '../services/Media.js';

import { DatabaseLive } from '../services/DatabaseLive.js';
import { DockerLive } from '../services/DockerLive.js';
import { CredentialsLive } from '../services/CredentialsLive.js';
import { TelegramLive } from '../services/TelegramLive.js';
import { ContainerRunnerLive } from '../services/ContainerRunnerLive.js';
import { GroupRegistryLive } from '../state/GroupRegistryLive.js';
import { SchedulerLive } from '../services/SchedulerLive.js';
import { SandboxLive } from '../services/SandboxLive.js';
import { BrowseHostLive } from '../services/BrowseHostLive.js';
import { TTSLive } from '../services/TTSLive.js';
import { SupermemoryLive } from '../services/SupermemoryLive.js';
import { MediaLive } from '../services/MediaLive.js';
import { AgentSemaphore, AgentSemaphoreLive } from '../coordinators/AgentSemaphore.js';

import type {
  DatabaseConnectionError,
  DatabaseMigrationError,
  TelegramConnectionError,
} from '../errors.js';

/**
 * MainLive — the full application layer.
 *
 * Dependency graph:
 *   Tier 0: AppConfig (no deps)
 *   Tier 1: Database, Docker, Credentials, Telegram, GroupRegistry,
 *           TTS, Supermemory, Media, AgentSemaphore (need AppConfig)
 *   Tier 2: ContainerRunner (needs Docker, Credentials, AppConfig)
 *           Sandbox (needs Docker, AppConfig)
 *   Tier 3: BrowseHost (needs Sandbox, Telegram, AppConfig)
 *           Scheduler (needs Database, ContainerRunner, GroupRegistry, AppConfig)
 */

// ── Tier 1: AppConfig-only deps ──────────────────────────────────────────────

const DatabaseResolved = DatabaseLive.pipe(Layer.provide(AppConfigLive));
const DockerResolved = DockerLive.pipe(Layer.provide(AppConfigLive));
const CredentialsResolved = CredentialsLive.pipe(Layer.provide(AppConfigLive));
const TelegramResolved = TelegramLive.pipe(Layer.provide(AppConfigLive));
const GroupRegistryResolved = GroupRegistryLive.pipe(
  Layer.provide(AppConfigLive),
);
const TTSResolved = TTSLive.pipe(Layer.provide(AppConfigLive));
const SupermemoryResolved = SupermemoryLive.pipe(Layer.provide(AppConfigLive));
const MediaResolved = MediaLive.pipe(Layer.provide(AppConfigLive));
const AgentSemaphoreResolved = AgentSemaphoreLive.pipe(
  Layer.provide(AppConfigLive),
);

// ── Tier 2: Multi-dep layers ─────────────────────────────────────────────────

const ContainerRunnerDeps = Layer.mergeAll(
  AppConfigLive,
  DockerResolved,
  CredentialsResolved,
);
const ContainerRunnerResolved = ContainerRunnerLive.pipe(
  Layer.provide(ContainerRunnerDeps),
);

const SandboxDeps = Layer.mergeAll(AppConfigLive, DockerResolved);
const SandboxResolved = SandboxLive.pipe(Layer.provide(SandboxDeps));

// ── Tier 3: Higher-dep layers ────────────────────────────────────────────────

const BrowseHostDeps = Layer.mergeAll(
  AppConfigLive,
  SandboxResolved,
  TelegramResolved,
);
const BrowseHostResolved = BrowseHostLive.pipe(Layer.provide(BrowseHostDeps));

const SchedulerDeps = Layer.mergeAll(
  AppConfigLive,
  DatabaseResolved,
  ContainerRunnerResolved,
  GroupRegistryResolved,
);
const SchedulerResolved = SchedulerLive.pipe(Layer.provide(SchedulerDeps));

// ── Merge everything ─────────────────────────────────────────────────────────

export const MainLive: Layer.Layer<
  | AppConfig
  | Database
  | Docker
  | Credentials
  | Telegram
  | ContainerRunner
  | GroupRegistry
  | Scheduler
  | Sandbox
  | BrowseHost
  | TTS
  | Supermemory
  | Media
  | AgentSemaphore,
  | DatabaseConnectionError
  | DatabaseMigrationError
  | TelegramConnectionError
> = Layer.mergeAll(
  AppConfigLive,
  DatabaseResolved,
  DockerResolved,
  CredentialsResolved,
  TelegramResolved,
  ContainerRunnerResolved,
  GroupRegistryResolved,
  SchedulerResolved,
  SandboxResolved,
  BrowseHostResolved,
  TTSResolved,
  SupermemoryResolved,
  MediaResolved,
  AgentSemaphoreResolved,
);
