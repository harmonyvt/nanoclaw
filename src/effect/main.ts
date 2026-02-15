/**
 * Effect entry point: NanoClaw with BunRuntime
 *
 * This is the new entry point that replaces src/index.ts.
 * It composes all Effect layers and runs the main program
 * using @effect/platform-bun's BunRuntime.
 *
 * Usage:
 *   bun src/effect/main.ts
 *   bun --watch src/effect/main.ts  (dev mode)
 */
import { Effect, Layer, pipe } from 'effect';
import { BunRuntime } from '@effect/platform-bun';

import { program } from './program.js';
import {
  ConfigLive,
  DatabaseLive,
  AppLoggerLive,
  PinoLoggerLive,
  TelegramLive,
  ContainerLive,
  SchedulerLive,
  BrowseLive,
  SandboxLive,
  MemoryLive,
  AuxiliaryLive,
} from './services/index.js';

// ─── Layer Composition ──────────────────────────────────────────────────────
//
// Effect layers form a dependency graph. Each service layer provides its
// service tag to the context. The AppLayer merges all live implementations.
//
// Layer hierarchy:
//   AppLayer
//   ├── ConfigLive          (no deps)
//   ├── AppLoggerLive       (no deps)
//   ├── PinoLoggerLive      (bridges Effect Logger → pino)
//   ├── DatabaseLive        (scoped: init on acquire, cleanup on release)
//   ├── TelegramLive        (no deps, wraps grammY)
//   ├── ContainerLive       (scoped: killAll on release)
//   ├── SchedulerLive       (no deps)
//   ├── BrowseLive          (scoped: disconnect on release)
//   ├── SandboxLive         (scoped: cleanup on release)
//   ├── MemoryLive          (no deps)
//   └── AuxiliaryLive       (scoped: stop all aux services on release)

const AppLayer = Layer.mergeAll(
  ConfigLive,
  AppLoggerLive,
  DatabaseLive,
  TelegramLive,
  ContainerLive,
  SchedulerLive,
  BrowseLive,
  SandboxLive,
  MemoryLive,
  AuxiliaryLive,
).pipe(Layer.provide(PinoLoggerLive));

// ─── Run ────────────────────────────────────────────────────────────────────

const runnable = program.pipe(
  Effect.scoped,
  Effect.provide(AppLayer),
);

BunRuntime.runMain(runnable);
