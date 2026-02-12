/**
 * Claude Agent SDK adapter for NanoClaw.
 *
 * Wraps the Claude Agent SDK `query()` call and normalizes its streaming
 * events into the provider-agnostic AgentEvent type.
 *
 * Stateless: each invocation creates a fresh session. Conversation history
 * is provided in the prompt (built from SQLite on the host side).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from '../ipc-mcp.js';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[claude-adapter] ${message}`);
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
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    const ipcMcp = createIpcMcp(input.ipcContext);
    const stderrBuffer: string[] = [];

    // Extended thinking state
    let thinkingBuffer = '';
    let lastThinkingYield = 0;

    const envThinkingTokens = parseInt(process.env.MAX_THINKING_TOKENS || '10000', 10);
    const maxThinkingTokens = input.enableThinking !== false ? envThinkingTokens : 0;

    // Set custom base URL if configured. The Claude Agent SDK's query() doesn't accept
    // a baseURL constructor param, so we set the env var it reads internally.
    // Safe here: each container runs a single serial query (no concurrent adapter risk).
    const baseUrl = input.baseUrl || process.env.ANTHROPIC_BASE_URL;
    if (baseUrl) {
      process.env.ANTHROPIC_BASE_URL = baseUrl;
    }

    for await (const message of query({
      prompt: input.prompt,
      options: {
        cwd: '/workspace/group',
        model: input.model,
        maxThinkingTokens: maxThinkingTokens > 0 ? maxThinkingTokens : undefined,
        includePartialMessages: true,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
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
      // Streaming thinking events (from includePartialMessages)
      if (message.type === 'stream_event') {
        const { event } = message as SDKStreamEvent;
        if (event && input.enableThinking !== false) {
          // Accumulate thinking deltas
          if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
            thinkingBuffer += event.delta.thinking || '';
            const now = Date.now();
            if (now - lastThinkingYield >= THINKING_YIELD_INTERVAL && thinkingBuffer.length > 0) {
              const snippet = thinkingBuffer.slice(-THINKING_SNAPSHOT_LENGTH);
              yield { type: 'thinking', content: snippet };
              lastThinkingYield = now;
            }
          }
          // Flush thinking buffer when a content block ends
          if (event.type === 'content_block_stop' && thinkingBuffer.length > 0) {
            const snippet = thinkingBuffer.slice(-THINKING_SNAPSHOT_LENGTH);
            yield { type: 'thinking', content: snippet };
            thinkingBuffer = '';
            lastThinkingYield = Date.now();
          }
        }
        continue; // Don't process stream_event through existing handlers
      }

      // Session init
      if (message.type === 'system' && message.subtype === 'init') {
        yield { type: 'session_init', sessionId: message.session_id };
      }

      // Final result
      if ('result' in message && message.result) {
        yield { type: 'result', result: message.result as string };
      }

      // Tool start events (assistant messages containing tool_use blocks)
      if (message.type === 'assistant' && 'message' in message) {
        const msg = message.message as {
          content?: Array<{ type: string; name?: string; input?: unknown }>;
        };
        const toolUses =
          msg.content?.filter((b: { type: string }) => b.type === 'tool_use') || [];
        for (const tu of toolUses) {
          yield {
            type: 'tool_start',
            toolName: (tu as { name?: string }).name || 'unknown',
            preview: JSON.stringify((tu as { input?: unknown }).input).slice(0, 200),
          };
        }
      }

      // Tool progress events
      if (message.type === 'tool_progress' && 'tool_name' in message) {
        yield {
          type: 'tool_progress',
          toolName: (message as { tool_name: string }).tool_name,
          elapsedSeconds: (message as { elapsed_time_seconds?: number }).elapsed_time_seconds,
        };
      }

      // Drain any buffered stderr messages
      while (stderrBuffer.length > 0) {
        yield { type: 'adapter_stderr', message: stderrBuffer.shift()! };
      }
    }

    // Drain any remaining stderr after the query ends
    while (stderrBuffer.length > 0) {
      yield { type: 'adapter_stderr', message: stderrBuffer.shift()! };
    }
  }
}
