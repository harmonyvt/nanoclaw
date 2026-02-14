/**
 * OpenAI Adapter for NanoClaw.
 *
 * Implements the ProviderAdapter interface using the OpenAI Chat Completions API
 * with function calling. Manages an agentic loop: sends messages to the model,
 * executes any tool calls via the NanoClaw tool registry, feeds results back,
 * and repeats until the model produces a final text response (no tool calls).
 *
 * Uses streaming to surface reasoning content incrementally (for o-series and
 * other reasoning models that emit reasoning_content on deltas).
 *
 * Stateless: conversation history is provided in the prompt (built from SQLite
 * on the host side as XML). This adapter parses the XML into proper role-based
 * messages for better OpenAI model quality.
 */

import OpenAI from 'openai';
import fs from 'fs';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';
import { buildOpenAITools, executeNanoToolFull } from './openai-tools.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import { isCancelled } from '../cancel.js';

// ─── Tool Result Limits ──────────────────────────────────────────────────────

/** Max chars for a single tool result to prevent context overflow (~3K tokens) */
const MAX_TOOL_RESULT_CHARS = 12_000;

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return result.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[Result truncated]';
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Min interval between yielding thinking snapshots (ms) — matches Claude adapter */
const THINKING_YIELD_INTERVAL = 3000;

/** Max chars of thinking content to include in a snapshot — matches Claude adapter */
const THINKING_SNAPSHOT_LENGTH = 4000;

/** Max agentic loop iterations to prevent runaway loops */
const MAX_ITERATIONS = 50;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[openai-adapter] ${message}`);
}

// ─── Reasoning Effort ───────────────────────────────────────────────────────

type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Resolve the reasoning_effort parameter for the API call.
 * Returns undefined if thinking is disabled.
 */
export function resolveReasoningEffort(
  enableThinking?: boolean,
): ReasoningEffort | undefined {
  if (enableThinking === false) return undefined;
  const envVal = (process.env.OPENAI_REASONING_EFFORT || 'medium').toLowerCase();
  if (envVal === 'low' || envVal === 'medium' || envVal === 'high') {
    return envVal;
  }
  return 'medium';
}

// ─── XML Conversation Parser ────────────────────────────────────────────────

export interface ParsedConversationMessage {
  role: 'user' | 'assistant';
  senderName: string;
  content: string;
  mediaType?: string;
  mediaPath?: string;
}

/**
 * Parse the <messages> XML block from the prompt into structured messages.
 * Expected format: <message role="user|assistant" sender="Name" time="...">content</message>
 * Also handles legacy format without role attribute (all treated as user).
 */
export function parseConversationXml(prompt: string): {
  conversationMessages: ParsedConversationMessage[];
  remainingPrompt: string;
} {
  const messagesMatch = prompt.match(/<messages>\n?([\s\S]*?)\n?<\/messages>/);
  if (!messagesMatch) {
    return { conversationMessages: [], remainingPrompt: prompt };
  }

  const messagesBlock = messagesMatch[1];
  const remainingPrompt = prompt.replace(/<messages>[\s\S]*?<\/messages>/, '').trim();

  const conversationMessages: ParsedConversationMessage[] = [];
  const messageRegex = /<message\s+([^>]*)>([\s\S]*?)<\/message>/g;
  let match;

  while ((match = messageRegex.exec(messagesBlock)) !== null) {
    const attrs = match[1];
    const content = match[2];

    // Parse attributes
    const roleMatch = attrs.match(/role="([^"]*)"/);
    const senderMatch = attrs.match(/sender="([^"]*)"/);
    const mediaTypeMatch = attrs.match(/media_type="([^"]*)"/);
    const mediaPathMatch = attrs.match(/media_path="([^"]*)"/);

    const role = roleMatch?.[1] === 'assistant' ? 'assistant' as const : 'user' as const;
    const senderName = senderMatch?.[1] || 'User';

    // Unescape XML entities
    const unescaped = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');

    const parsed: ParsedConversationMessage = { role, senderName, content: unescaped };
    if (mediaTypeMatch?.[1]) parsed.mediaType = mediaTypeMatch[1];
    if (mediaPathMatch?.[1]) parsed.mediaPath = mediaPathMatch[1];
    conversationMessages.push(parsed);
  }

  return { conversationMessages, remainingPrompt };
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

/**
 * Build the system prompt for the OpenAI model.
 *
 * Includes:
 * - Base identity (assistant name)
 * - Group-specific CLAUDE.md instructions (if present)
 * - Global CLAUDE.md instructions for non-main groups (if present)
 * - Summary of available NanoClaw tools
 */
export function buildSystemPrompt(input: AdapterInput): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful AI assistant.`);
  parts.push(
    'If the prompt contains a <soul> block, treat that identity/personality as authoritative.',
  );

  // Load CLAUDE.md for group instructions
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  try {
    if (fs.existsSync(claudeMdPath)) {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8').trim();
      if (claudeMd) {
        parts.push('\n## Instructions\n');
        parts.push(claudeMd);
      }
    }
  } catch {
    // Ignore read errors -- group may not have instructions
  }

  // Load global CLAUDE.md for non-main groups
  if (!input.isMain) {
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    try {
      if (fs.existsSync(globalClaudeMdPath)) {
        const globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8').trim();
        if (globalClaudeMd) {
          parts.push('\n## Global Instructions\n');
          parts.push(globalClaudeMd);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // Tool descriptions
  parts.push('\n## Available Tools\n');
  parts.push('You have access to the following tools. Use them when needed:\n');
  for (const tool of NANOCLAW_TOOLS) {
    parts.push(`- **${tool.name}**: ${tool.description}`);
  }

  return parts.join('\n');
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class OpenAIAdapter implements ProviderAdapter {
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    const client = new OpenAI({
      baseURL: input.baseUrl || process.env.OPENAI_BASE_URL || undefined,
    });
    const model = input.model || 'gpt-4o';
    const reasoningEffort = resolveReasoningEffort(input.enableThinking);

    yield { type: 'session_init', sessionId: `openai-${Date.now()}` };

    // Parse conversation history from the prompt XML into proper role-based messages
    const { conversationMessages, remainingPrompt } = parseConversationXml(input.prompt);

    const systemPrompt = buildSystemPrompt(input);
    const tools = buildOpenAITools();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history as proper role-based messages
    for (const msg of conversationMessages) {
      if (msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      } else {
        const prefix = msg.senderName ? `${msg.senderName}: ` : '';
        const textContent = `${prefix}${msg.content}`;

        // Inject image as multimodal content for photo messages
        if (msg.mediaType === 'photo' && msg.mediaPath) {
          try {
            if (fs.existsSync(msg.mediaPath)) {
              const imageData = fs.readFileSync(msg.mediaPath);
              const base64 = imageData.toString('base64');
              const ext = msg.mediaPath.split('.').pop()?.toLowerCase() || 'jpg';
              const mimeType = ext === 'png' ? 'image/png'
                : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif'
                : 'image/jpeg';
              messages.push({
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'auto' } },
                  { type: 'text', text: textContent },
                ],
              } as OpenAI.ChatCompletionMessageParam);
              continue;
            }
          } catch {
            // Fall through to text-only if image can't be read
          }
        }

        messages.push({ role: 'user', content: textContent });
      }
    }

    // Add any remaining prompt content (e.g., <soul>, <skill>, <memory> blocks)
    if (remainingPrompt) {
      messages.push({ role: 'user', content: remainingPrompt });
    }

    log(`Starting with ${messages.length} messages (${conversationMessages.length} from history)`);
    if (reasoningEffort) {
      log(`Reasoning effort: ${reasoningEffort}`);
    }

    // Thinking state (mirrors Claude adapter pattern)
    let thinkingBuffer = '';
    let lastThinkingYield = 0;

    let iterations = 0;
    let consecutiveToolErrors = 0;
    const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

    while (true) {
      iterations++;
      if (iterations > MAX_ITERATIONS) {
        log(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
        break;
      }

      // Check for user interrupt
      if (isCancelled()) {
        log('Cancel detected, stopping OpenAI loop');
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        const partial = lastAssistant && 'content' in lastAssistant ? String(lastAssistant.content) : null;
        if (partial) yield { type: 'result', result: partial };
        return;
      }

      log(`Iteration ${iterations}, sending ${messages.length} messages to ${model} (stream)`);

      // Build create params, conditionally including reasoning_effort
      const createParams: Record<string, unknown> = {
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      };
      if (reasoningEffort) {
        createParams.reasoning_effort = reasoningEffort;
      }

      const stream = (await client.chat.completions.create(
        createParams as any,
      )) as unknown as AsyncIterable<any>;

      // Accumulate the complete assistant message from stream chunks
      let contentBuffer = '';
      let reasoningBuffer = '';
      const toolCallAccumulators = new Map<number, {
        id: string;
        name: string;
        arguments: string;
      }>();

      for await (const chunk of stream) {
        // Check for cancellation mid-stream
        if (isCancelled()) {
          log('Cancel detected mid-stream, aborting');
          try { (stream as any).controller?.abort(); } catch {}
          const partial = contentBuffer || null;
          if (partial) yield { type: 'result', result: partial };
          return;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // 1. Accumulate reasoning content (not in official SDK types)
        const reasoningDelta = (delta as any).reasoning_content;
        if (reasoningDelta && input.enableThinking !== false) {
          thinkingBuffer += reasoningDelta;
          reasoningBuffer += reasoningDelta;
          const now = Date.now();
          if (now - lastThinkingYield >= THINKING_YIELD_INTERVAL && thinkingBuffer.length > 0) {
            const snippet = thinkingBuffer.slice(-THINKING_SNAPSHOT_LENGTH);
            yield { type: 'thinking', content: snippet };
            lastThinkingYield = now;
          }
        }

        // 2. Accumulate text content
        if (delta.content) {
          contentBuffer += delta.content;
        }

        // 3. Accumulate tool calls (streamed as indexed deltas)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let acc = toolCallAccumulators.get(idx);
            if (!acc) {
              acc = { id: tc.id || '', name: '', arguments: '' };
              toolCallAccumulators.set(idx, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }

      // Flush remaining thinking buffer at end of stream
      if (thinkingBuffer.length > 0 && input.enableThinking !== false) {
        const snippet = thinkingBuffer.slice(-THINKING_SNAPSHOT_LENGTH);
        yield { type: 'thinking', content: snippet };
        thinkingBuffer = '';
        lastThinkingYield = Date.now();
      }

      // Reconstruct tool calls from accumulated deltas
      const toolCalls = [...toolCallAccumulators.values()]
        .filter(tc => tc.id && tc.name)
        .map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

      // Reconstruct the assistant message for the messages array
      const assistantMessage: any = {
        role: 'assistant' as const,
        content: contentBuffer || null,
      };
      if (reasoningBuffer) {
        assistantMessage.reasoning_content = reasoningBuffer;
      }
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      messages.push(assistantMessage);

      // No tool calls = final response
      if (toolCalls.length === 0) {
        if (contentBuffer) {
          yield { type: 'result', result: contentBuffer };
        }
        break;
      }

      // Execute each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        yield {
          type: 'tool_start',
          toolName,
          preview: toolCall.function.arguments.slice(0, 200),
        };

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        const toolResult = await executeNanoToolFull(toolName, args, input.ipcContext);

        if (toolResult.isError) {
          consecutiveToolErrors++;
        } else {
          consecutiveToolErrors = 0;
        }

        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: truncateToolResult(toolResult.content),
        });

        // Inject screenshot image for vision-capable models (OpenAI role:'tool' only accepts strings)
        if (toolResult.imageBase64) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${toolResult.imageMimeType || 'image/png'};base64,${toolResult.imageBase64}`,
                  detail: 'low',
                },
              },
              {
                type: 'text',
                text: 'Screenshot from browse_screenshot above.',
              },
            ],
          } as OpenAI.ChatCompletionMessageParam);
        }
      }

      // Break out of retry loops: if multiple consecutive tool calls failed, nudge the model
      if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        log(`${consecutiveToolErrors} consecutive tool errors, injecting guidance`);
        messages.push({
          role: 'user' as const,
          content:
            '[System: Multiple tool calls failed in a row. Stop retrying failed tools. Use only the tools listed in your Available Tools. For file operations, use read_file and write_file. Respond to the user with what you can do.]',
        });
        consecutiveToolErrors = 0;
      }

      // Reset per-iteration reasoning buffer (thinkingBuffer persists for throttling)
      reasoningBuffer = '';
    }
  }
}
