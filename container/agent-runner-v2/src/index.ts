/**
 * NanoClaw Agent Runner v2 — Effect-based container agent entry point.
 *
 * Supports two modes:
 * - One-shot (stdin): receives config via stdin, outputs result to stdout, exits
 * - Persistent (RPC server): listens on a Unix socket, processes run_query requests
 *
 * Persistent mode eliminates ~3s SDK import + CLI spawn overhead per message by
 * keeping the process alive and reusing the imported SDK.
 */

import { Effect, Layer, Stream } from 'effect';
import type { ContainerInput, ContainerOutput } from './schemas/ContainerIO.js';
import { decodeContainerInput } from './rpc/oneshot.js';
import type { AgentEvent } from './schemas/AgentEvent.js';
import { createAdapter } from './adapters/index.js';
import {
  HostBridge,
  HostBridgeOneShot,
  ToolRegistryLive,
  CancellationLive,
  PromptBuilder,
  PromptBuilderLive,
  StatusEmitter,
  StatusEmitterRpc,
  StatusEmitterFile,
  Cancellation,
} from './services/index.js';
import { RpcServer, RpcServerLive } from './rpc/server.js';
import { runOneShot, writeOutput } from './rpc/oneshot.js';
import type { HostBridgeService } from './services/HostBridge.js';

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[agent-runner-v2] ${msg}\n`);
}

// ─── Query Execution (shared by both modes) ──────────────────────────────────

async function runQuery(
  input: ContainerInput,
  bridgeLayer: Layer.Layer<HostBridge>,
  statusLayer?: Layer.Layer<StatusEmitter>,
): Promise<ContainerOutput> {
  const provider = input.provider || 'anthropic';
  const adapter = createAdapter(provider);

  // Build the service layers
  const servicesLayer = Layer.mergeAll(
    bridgeLayer,
    ToolRegistryLive,
    CancellationLive,
  );

  // Build the prompt using PromptBuilder
  const prompt = await Effect.runPromise(
    Effect.gen(function* () {
      const builder = yield* PromptBuilder;
      return yield* builder.prepare(input);
    }).pipe(Effect.provide(PromptBuilderLive)),
  );

  // Resolve StatusEmitter: persistent mode uses RPC, one-shot mode uses file IPC
  const resolvedStatusLayer = statusLayer ?? StatusEmitterFile;

  const fullLayer = Layer.provideMerge(resolvedStatusLayer, servicesLayer);

  const adapterInput = {
    prompt,
    model: input.model,
    baseUrl: input.baseUrl,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask,
    assistantName: input.assistantName,
    enableThinking: input.enableThinking,
    ipcContext: {
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
    },
  };

  let result: string | null = null;

  try {
    log('Starting agent query...');

    await Effect.runPromise(
      Stream.runForEach(adapter.run(adapterInput), (event: AgentEvent) =>
        Effect.gen(function* () {
          const status = yield* StatusEmitter;
          const cancellation = yield* Cancellation;

          // Check for cancellation between events
          const cancelled = yield* cancellation.isCancelled;
          if (cancelled) {
            log('Cancel detected, aborting query');
            result = result || '[Interrupted by user]';
            return;
          }

          switch (event.type) {
            case 'session_init':
              log(`Session initialized: ${event.sessionId}`);
              break;
            case 'result':
              result = event.result;
              break;
            case 'tool_start':
              yield* status.emit({
                type: 'tool_start',
                tool_name: event.toolName,
                preview: event.preview,
              });
              break;
            case 'tool_progress':
              yield* status.emit({
                type: 'tool_progress',
                tool_name: event.toolName,
                elapsed_seconds: event.elapsedSeconds,
              });
              break;
            case 'thinking':
              yield* status.emit({
                type: 'thinking',
                content: event.content,
              });
              break;
            case 'response_delta':
              yield* status.emit({
                type: 'response_delta',
                content: event.content,
              });
              break;
            case 'adapter_stderr':
              yield* status.emit({
                type: 'adapter_stderr',
                message: event.message,
              });
              break;
          }
        }),
      ).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            const errorMessage = err instanceof Error
              ? err.message
              : 'message' in err
                ? (err as { message: string }).message
                : String(err);
            log(`Adapter error: ${errorMessage}`);
            result = null;
          }),
        ),
        Effect.provide(fullLayer),
      ),
    );

    log('Agent query completed successfully');
    return { status: 'success', result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return { status: 'error', result: null, error: errorMessage };
  }
}

// ─── One-shot Mode ──────────────────────────────────────────────────────────

function startOneShotMode(): Effect.Effect<void, never> {
  return runOneShot(async (input) => {
    return runQuery(input, HostBridgeOneShot);
  });
}

// ─── Persistent Mode ────────────────────────────────────────────────────────

function startPersistentMode(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const rpcServer = yield* RpcServer;

    yield* rpcServer.onQuery(
      async (params: unknown, bridge: HostBridgeService) => {
        const input = await Effect.runPromise(decodeContainerInput(params));
        const bridgeLayer = Layer.succeed(HostBridge, bridge);
        // Persistent mode: StatusEmitter uses RPC bridge for real-time events
        const statusLayer = Layer.succeed(StatusEmitter, {
          emit: (event: Record<string, unknown>) => bridge.notify('status.event', event),
        });
        return runQuery(input, bridgeLayer, statusLayer);
      },
    );
  }).pipe(
    Effect.provide(RpcServerLive),
    Effect.catchAllDefect((defect) =>
      Effect.sync(() => {
        log(`Persistent mode error: ${defect instanceof Error ? defect.message : String(defect)}`);
        process.exit(1);
      }),
    ),
  );
}

// ─── Mode Detection & Entry Point ────────────────────────────────────────────

const main = Effect.gen(function* () {
  const forcePersistent = process.env.NANOCLAW_PERSISTENT === '1';
  const isPiped = !process.stdin.isTTY;

  if (forcePersistent) {
    log('Mode: persistent (NANOCLAW_PERSISTENT=1)');
    yield* startPersistentMode();
  } else if (!isPiped) {
    log('Mode: persistent (no stdin detected)');
    yield* startPersistentMode();
  } else {
    log('Mode: one-shot (stdin detected)');
    yield* startOneShotMode();
  }
});

Effect.runPromise(main).catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
