/**
 * Claude Agent SDK adapter for NanoClaw.
 *
 * Wraps the Claude Agent SDK `query()` call and normalizes its streaming
 * events into the provider-agnostic AgentEvent type. All Claude-specific
 * helpers (PreCompact hook, transcript archiving, session index lookup)
 * live here so that the main runner stays provider-neutral.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from '../ipc-mcp.js';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[claude-adapter] ${message}`);
}

// ─── Transcript / Session Helpers ────────────────────────────────────────────

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content =
      msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
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

    const maxThinkingTokens = parseInt(process.env.MAX_THINKING_TOKENS || '10000', 10);

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
        resume: input.sessionId,
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
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(input.assistantName)] }],
        },
      },
    })) {
      // Streaming thinking events (from includePartialMessages)
      if (message.type === 'stream_event') {
        const { event } = message as SDKStreamEvent;
        if (event) {
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
