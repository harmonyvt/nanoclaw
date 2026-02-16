/**
 * Claude Agent SDK adapter for NanoClaw v2.
 *
 * Wraps the Claude Agent SDK `query()` call and normalizes its streaming
 * events into an Effect Stream of AgentEvent.
 *
 * Stateless: each invocation creates a fresh session. Conversation history
 * is provided in the prompt (built from SQLite on the host side).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Effect, Stream, Layer } from 'effect';
import type { AgentEvent } from '../schemas/AgentEvent.js';
import { AdapterError } from '../errors/index.js';
import { HostBridge } from '../services/HostBridge.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import type { Cancellation } from '../services/Cancellation.js';
import { createIpcMcp } from '../mcp/ipc-mcp.js';
import type { AdapterInput, ProviderAdapter } from './types.js';

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  process.stderr.write(`[claude-adapter] ${message}\n`);
}

// ─── Thinking Stream Types & Constants ───────────────────────────────────────

/** Shape of a streaming event from the Claude SDK (includePartialMessages) */
interface SDKStreamEvent {
  type: 'stream_event';
  event?: {
    type: string;
    delta?: {
      type: string;
      thinking?: string;
    };
  };
}

/** Min interval between yielding thinking snapshots (ms) */
const THINKING_YIELD_INTERVAL = 3000;

/** Max chars of thinking content to include in a snapshot */
const THINKING_SNAPSHOT_LENGTH = 4000;

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ClaudeAdapter implements ProviderAdapter {
  run(
    input: AdapterInput,
  ): Stream.Stream<AgentEvent, AdapterError, HostBridge | ToolRegistry | Cancellation> {
    return Stream.fromEffect(
      Effect.gen(function* () {
        // Resolve the HostBridge layer for MCP tool execution
        const bridge = yield* HostBridge;
        const bridgeLayer = Layer.succeed(HostBridge, bridge);

        return bridgeLayer;
      }),
    ).pipe(
      Stream.flatMap((bridgeLayer) =>
        Stream.async<AgentEvent, AdapterError>((emit) => {
          void (async () => {
            try {
              const ipcMcp = createIpcMcp(input.ipcContext, bridgeLayer);
              const stderrBuffer: string[] = [];

              // Extended thinking state
              let thinkingBuffer = '';
              let lastThinkingYield = 0;

              const envThinkingTokens = parseInt(
                process.env.MAX_THINKING_TOKENS || '10000',
                10,
              );
              const maxThinkingTokens =
                input.enableThinking !== false ? envThinkingTokens : 0;

              // Set custom base URL if configured
              const baseUrl =
                input.baseUrl || process.env.ANTHROPIC_BASE_URL;
              if (baseUrl) {
                process.env.ANTHROPIC_BASE_URL = baseUrl;
              }

              for await (const message of query({
                prompt: input.prompt,
                options: {
                  cwd: '/workspace/group',
                  model: input.model,
                  maxThinkingTokens:
                    maxThinkingTokens > 0 ? maxThinkingTokens : undefined,
                  includePartialMessages: true,
                  allowedTools: [
                    'Bash',
                    'Read',
                    'Write',
                    'Edit',
                    'Glob',
                    'Grep',
                    'WebSearch',
                    'WebFetch',
                    'mcp__nanoclaw__*',
                  ],
                  permissionMode: 'bypassPermissions',
                  allowDangerouslySkipPermissions: true,
                  stderr: (data: string) => {
                    const trimmed = data.trimEnd();
                    if (trimmed) {
                      log(`[claude-cli stderr] ${trimmed}`);
                      stderrBuffer.push(trimmed);
                    }
                  },
                  settingSources: ['project'],
                  mcpServers: {
                    nanoclaw: ipcMcp,
                  },
                },
              })) {
                // Streaming thinking events
                if (message.type === 'stream_event') {
                  const { event } = message as SDKStreamEvent;
                  if (event && input.enableThinking !== false) {
                    if (
                      event.type === 'content_block_delta' &&
                      event.delta?.type === 'thinking_delta'
                    ) {
                      thinkingBuffer += event.delta.thinking || '';
                      const now = Date.now();
                      if (
                        now - lastThinkingYield >= THINKING_YIELD_INTERVAL &&
                        thinkingBuffer.length > 0
                      ) {
                        const snippet = thinkingBuffer.slice(
                          -THINKING_SNAPSHOT_LENGTH,
                        );
                        emit.single({ type: 'thinking', content: snippet });
                        lastThinkingYield = now;
                      }
                    }
                    if (
                      event.type === 'content_block_stop' &&
                      thinkingBuffer.length > 0
                    ) {
                      const snippet = thinkingBuffer.slice(
                        -THINKING_SNAPSHOT_LENGTH,
                      );
                      emit.single({ type: 'thinking', content: snippet });
                      thinkingBuffer = '';
                      lastThinkingYield = Date.now();
                    }
                  }
                  continue;
                }

                // Session init
                if (
                  message.type === 'system' &&
                  message.subtype === 'init'
                ) {
                  emit.single({
                    type: 'session_init',
                    sessionId: message.session_id,
                  });
                }

                // Final result
                if ('result' in message && message.result) {
                  emit.single({
                    type: 'result',
                    result: message.result as string,
                  });
                }

                // Tool start events
                if (
                  message.type === 'assistant' &&
                  'message' in message
                ) {
                  const msg = message.message as {
                    content?: Array<{
                      type: string;
                      name?: string;
                      input?: unknown;
                    }>;
                  };
                  const toolUses =
                    msg.content?.filter(
                      (b: { type: string }) => b.type === 'tool_use',
                    ) || [];
                  for (const tu of toolUses) {
                    emit.single({
                      type: 'tool_start',
                      toolName:
                        (tu as { name?: string }).name || 'unknown',
                      preview: JSON.stringify(
                        (tu as { input?: unknown }).input,
                      ).slice(0, 200),
                    });
                  }
                }

                // Tool progress events
                if (
                  message.type === 'tool_progress' &&
                  'tool_name' in message
                ) {
                  emit.single({
                    type: 'tool_progress',
                    toolName: (message as { tool_name: string }).tool_name,
                    elapsedSeconds: (
                      message as { elapsed_time_seconds?: number }
                    ).elapsed_time_seconds,
                  });
                }

                // Drain any buffered stderr messages
                while (stderrBuffer.length > 0) {
                  emit.single({
                    type: 'adapter_stderr',
                    message: stderrBuffer.shift()!,
                  });
                }
              }

              // Drain remaining stderr
              while (stderrBuffer.length > 0) {
                emit.single({
                  type: 'adapter_stderr',
                  message: stderrBuffer.shift()!,
                });
              }

              emit.end();
            } catch (err) {
              emit.fail(
                new AdapterError({
                  provider: 'anthropic',
                  message:
                    err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
              );
            }
          })();
        }),
      ),
    );
  }
}
