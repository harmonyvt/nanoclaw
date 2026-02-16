/**
 * NanoClaw v2 — Tagged error types.
 * All errors extend Data.TaggedError for exhaustive pattern matching
 * and typed error channels in Effect.
 */

import { Data } from 'effect';

// ─── Database ──────────────────────────────────────────────────────────────

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export class DatabaseConnectionError extends Data.TaggedError(
  'DatabaseConnectionError',
)<{
  readonly message: string;
  readonly path: string;
}> {}

export class DatabaseMigrationError extends Data.TaggedError(
  'DatabaseMigrationError',
)<{
  readonly message: string;
  readonly migration: string;
}> {}

// ─── Telegram ──────────────────────────────────────────────────────────────

export class TelegramError extends Data.TaggedError('TelegramError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TelegramConnectionError extends Data.TaggedError(
  'TelegramConnectionError',
)<{
  readonly message: string;
}> {}

export class TelegramSendError extends Data.TaggedError('TelegramSendError')<{
  readonly message: string;
  readonly chatJid: string;
  readonly cause?: unknown;
}> {}

// ─── Docker ────────────────────────────────────────────────────────────────

export class DockerError extends Data.TaggedError('DockerError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DockerNotRunningError extends Data.TaggedError(
  'DockerNotRunningError',
)<{
  readonly message: string;
}> {}

export class DockerImageMissingError extends Data.TaggedError(
  'DockerImageMissingError',
)<{
  readonly image: string;
}> {}

export class DockerImageBuildError extends Data.TaggedError(
  'DockerImageBuildError',
)<{
  readonly image: string;
  readonly cause?: unknown;
}> {}

// ─── Container ─────────────────────────────────────────────────────────────

export class ContainerError extends Data.TaggedError('ContainerError')<{
  readonly message: string;
  readonly groupFolder: string;
  readonly cause?: unknown;
}> {}

export class ContainerTimeoutError extends Data.TaggedError(
  'ContainerTimeoutError',
)<{
  readonly groupFolder: string;
  readonly timeoutMs: number;
}> {}

export class ContainerOutputParseError extends Data.TaggedError(
  'ContainerOutputParseError',
)<{
  readonly groupFolder: string;
  readonly rawOutput: string;
}> {}

export class ContainerInterruptedError extends Data.TaggedError(
  'ContainerInterruptedError',
)<{
  readonly groupFolder: string;
}> {}

export class ContainerNonRetryableError extends Data.TaggedError(
  'ContainerNonRetryableError',
)<{
  readonly message: string;
  readonly groupFolder: string;
}> {}

// ─── Sandbox ───────────────────────────────────────────────────────────────

export class SandboxError extends Data.TaggedError('SandboxError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SandboxStartError extends Data.TaggedError('SandboxStartError')<{
  readonly message: string;
  readonly image: string;
}> {}

export class SandboxNotRunningError extends Data.TaggedError(
  'SandboxNotRunningError',
)<{
  readonly message: string;
}> {}

// ─── Browse ────────────────────────────────────────────────────────────────

export class BrowseError extends Data.TaggedError('BrowseError')<{
  readonly message: string;
  readonly action: string;
  readonly cause?: unknown;
}> {}

export class BrowseWaitTimeoutError extends Data.TaggedError(
  'BrowseWaitTimeoutError',
)<{
  readonly requestId: string;
  readonly groupFolder: string;
}> {}

// ─── Credentials ───────────────────────────────────────────────────────────

export class CredentialError extends Data.TaggedError('CredentialError')<{
  readonly message: string;
  readonly source: 'dotenv' | 'keychain' | 'credentials-file' | 'none';
}> {}

export class OAuthRefreshError extends Data.TaggedError('OAuthRefreshError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ─── Scheduler ─────────────────────────────────────────────────────────────

export class SchedulerError extends Data.TaggedError('SchedulerError')<{
  readonly message: string;
  readonly taskId?: string;
  readonly cause?: unknown;
}> {}

// ─── TTS ───────────────────────────────────────────────────────────────────

export class TTSError extends Data.TaggedError('TTSError')<{
  readonly message: string;
  readonly provider: string;
  readonly cause?: unknown;
}> {}

// ─── Supermemory ───────────────────────────────────────────────────────────

export class MemoryError extends Data.TaggedError('MemoryError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ─── Media ─────────────────────────────────────────────────────────────────

export class MediaError extends Data.TaggedError('MediaError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TranscriptionError extends Data.TaggedError(
  'TranscriptionError',
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
