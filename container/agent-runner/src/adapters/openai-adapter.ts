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

/** Min interval between yielding response content snapshots (ms) */
const RESPONSE_YIELD_INTERVAL = 3000;

/** Max agentic loop iterations to prevent runaway loops */
const MAX_ITERATIONS = 50;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[openai-adapter] ${message}`);
}

// ─── Reasoning Effort ───────────────────────────────────────────────────────

type ReasoningEffort = 'low' | 'medium' | 'high';
type ReasoningParamMode = 'none' | 'reasoning_effort' | 'reasoning_object';

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

function chooseReasoningParamMode(
  baseUrl: string | undefined,
  reasoningEffort: ReasoningEffort | undefined,
): ReasoningParamMode {
  if (!reasoningEffort) return 'none';
  // OpenRouter can reject requests when both styles are present. Prefer `reasoning`.
  if (baseUrl?.includes('openrouter.ai')) return 'reasoning_object';
  return 'reasoning_effort';
}

function isReasoningParamConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /only one of ["']?reasoning["']? and ["']?reasoning_effort["']?/i.test(msg);
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

// ─── Provider-Specific Types ────────────────────────────────────────────

/** Delta shape extended with reasoning fields from various providers */
type ProviderDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: Array<{ type: string; text?: string }>;
};

/** OpenAI create params extended with OpenRouter-specific fields */
type ExtendedCreateParams = OpenAI.ChatCompletionCreateParamsStreaming & {
  reasoning?: { effort: string };
};

// ─── Reasoning Delta Extraction ─────────────────────────────────────────

/**
 * Extract reasoning/thinking content from a streaming delta.
 * Handles multiple field formats used by different providers:
 * - `reasoning_content` (OpenAI o-series, OpenRouter alias)
 * - `reasoning` (OpenRouter primary field)
 * - `reasoning_details` (OpenRouter structured array with type:"reasoning.text")
 */
function extractReasoningDelta(delta: ProviderDelta): string | undefined {
  // OpenRouter primary field
  if (typeof delta.reasoning === 'string' && delta.reasoning) {
    return delta.reasoning;
  }
  // OpenAI o-series / OpenRouter alias
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    return delta.reasoning_content;
  }
  // OpenRouter structured array format
  if (Array.isArray(delta.reasoning_details)) {
    const texts: string[] = [];
    for (const d of delta.reasoning_details) {
      if (d?.type === 'reasoning.text' && typeof d.text === 'string') {
        texts.push(d.text);
      }
    }
    if (texts.length > 0) return texts.join('');
  }
  return undefined;
}

// ─── Inline Think-Tag Stripping ─────────────────────────────────────────────

/**
 * Strip `<think>...</think>` blocks from content.
 * Some models (e.g., kimi-k2.5 via OpenRouter) embed reasoning in these tags
 * within `delta.content` instead of using dedicated reasoning fields.
 * Returns the cleaned content and the extracted thinking text.
 */
export function stripThinkTags(content: string): { cleaned: string; thinking: string } {
  const thinkParts: string[] = [];
  // Match both complete <think>...</think> blocks and unclosed trailing <think>...
  const cleaned = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_match, inner) => {
    if (inner.trim()) thinkParts.push(inner.trim());
    return '';
  });
  return { cleaned: cleaned.trim(), thinking: thinkParts.join('\n') };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class OpenAIAdapter implements ProviderAdapter {
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    // Buffered log messages that get yielded as adapter_stderr events
    const logBuffer: string[] = [];
    const bufLog = (msg: string) => { log(msg); logBuffer.push(msg); };

    const client = new OpenAI({
      baseURL: input.baseUrl || process.env.OPENAI_BASE_URL || undefined,
    });
    const model = input.model || 'gpt-4o';
    const reasoningEffort = resolveReasoningEffort(input.enableThinking);
    let reasoningParamMode = chooseReasoningParamMode(input.baseUrl || process.env.OPENAI_BASE_URL, reasoningEffort);

    const effectiveBaseUrl = input.baseUrl || process.env.OPENAI_BASE_URL || '(default)';
    bufLog(`Client config: model=${model}, baseURL=${effectiveBaseUrl}, thinking=${input.enableThinking !== false}`);
    bufLog(`Reasoning effort: ${reasoningEffort || 'disabled'}`);

    yield { type: 'session_init', sessionId: `openai-${Date.now()}` };

    // Parse conversation history from the prompt XML into proper role-based messages
    const { conversationMessages, remainingPrompt } = parseConversationXml(input.prompt);

    const systemPrompt = buildSystemPrompt(input);
    const tools = buildOpenAITools();
    bufLog(`System prompt: ${systemPrompt.length} chars, tools: ${tools.length}`);

    // Drain initial log buffer
    while (logBuffer.length > 0) {
      yield { type: 'adapter_stderr', message: logBuffer.shift()! };
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history as proper role-based messages
    let imageCount = 0;
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
              imageCount++;
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

    bufLog(`Conversation: ${messages.length} messages (${conversationMessages.length} from history, ${imageCount} images)`);
    bufLog(`Remaining prompt blocks: ${remainingPrompt.length} chars`);

    // Thinking state (mirrors Claude adapter pattern)
    let thinkingBuffer = '';
    let lastThinkingYield = 0;

    // Response streaming state
    let lastResponseYield = 0;

    let iterations = 0;
    let consecutiveToolErrors = 0;
    const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

    while (true) {
      iterations++;
      if (iterations > MAX_ITERATIONS) {
        bufLog(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
        break;
      }

      // Check for user interrupt
      if (isCancelled()) {
        bufLog('Cancel detected, stopping OpenAI loop');
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        const partial = lastAssistant && 'content' in lastAssistant ? String(lastAssistant.content) : null;
        if (partial) yield { type: 'result', result: partial };
        return;
      }

      bufLog(`Iteration ${iterations}, sending ${messages.length} messages to ${model} (stream)`);

      // Build create params, conditionally including reasoning config
      const createParams: ExtendedCreateParams = {
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      };
      if (reasoningEffort && reasoningParamMode === 'reasoning_effort') {
        createParams.reasoning_effort = reasoningEffort;
      } else if (reasoningEffort && reasoningParamMode === 'reasoning_object') {
        createParams.reasoning = { effort: reasoningEffort };
      }

      const reqParamKeys = Object.keys(createParams).filter(k => k !== 'messages');
      const paramsRecord = createParams as unknown as Record<string, unknown>;
      bufLog(`Request params: ${JSON.stringify(Object.fromEntries(reqParamKeys.map(k => [k, k === 'tools' ? `[${createParams.tools?.length || 0} tools]` : paramsRecord[k]])))}`);

      // Drain log buffer before API call
      while (logBuffer.length > 0) {
        yield { type: 'adapter_stderr', message: logBuffer.shift()! };
      }

      const streamStartTime = Date.now();
      let chunkCount = 0;
      let firstChunkTime = 0;

      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        stream = (await client.chat.completions.create(
          createParams as OpenAI.ChatCompletionCreateParamsStreaming,
        )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
        bufLog(`Stream created in ${Date.now() - streamStartTime}ms`);
      } catch (apiErr) {
        // Some providers (notably OpenRouter) reject mixed reasoning params.
        // If that happens, disable reasoning params for this run and retry once.
        if (reasoningParamMode !== 'none' && isReasoningParamConflictError(apiErr)) {
          bufLog('Reasoning parameter conflict detected; retrying request with reasoning disabled');
          reasoningParamMode = 'none';
          const fallbackParams: Record<string, unknown> = {
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
          };
          stream = (await client.chat.completions.create(
            fallbackParams as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
          )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
          bufLog(`Stream created (fallback) in ${Date.now() - streamStartTime}ms`);
        } else {
          const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
          const errObj = apiErr as Record<string, unknown>;
          const status = errObj?.status || (errObj?.response as Record<string, unknown>)?.status || 'unknown';
          bufLog(`API request failed: status=${status}, error=${errMsg}`);
          if (errObj?.error) {
            bufLog(`API error body: ${JSON.stringify(errObj.error).slice(0, 500)}`);
          }
          // Drain error logs before throwing
          while (logBuffer.length > 0) {
            yield { type: 'adapter_stderr', message: logBuffer.shift()! };
          }
          throw apiErr;
        }
      }

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
          bufLog('Cancel detected mid-stream, aborting');
          try { (stream as { controller?: { abort(): void } }).controller?.abort(); } catch {}
          const partial = contentBuffer || null;
          if (partial) yield { type: 'result', result: partial };
          return;
        }

        chunkCount++;
        if (chunkCount === 1) firstChunkTime = Date.now();

        const delta = chunk.choices?.[0]?.delta as ProviderDelta | undefined;
        if (!delta) continue;

        // Log delta keys on first few chunks for debugging provider compatibility
        if (chunkCount <= 3) {
          const deltaRecord = delta as Record<string, unknown>;
          const deltaKeys = Object.keys(deltaRecord).filter(k => deltaRecord[k] != null && deltaRecord[k] !== '');
          if (deltaKeys.length > 0) {
            bufLog(`Chunk #${chunkCount} delta keys: [${deltaKeys.join(', ')}]`);
          }
        }

        // 1. Accumulate reasoning content (handles multiple provider formats)
        const reasoningDelta = extractReasoningDelta(delta);
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

          // Yield accumulated response for progressive display (strip think tags)
          const now2 = Date.now();
          if (now2 - lastResponseYield >= RESPONSE_YIELD_INTERVAL) {
            const { cleaned: deltaClean } = stripThinkTags(contentBuffer);
            if (deltaClean) {
              yield { type: 'response_delta', content: deltaClean };
            }
            lastResponseYield = now2;
          }
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

      // Log stream completion stats
      const streamDuration = Date.now() - streamStartTime;
      const ttft = firstChunkTime ? firstChunkTime - streamStartTime : 0;
      bufLog(`Stream complete: ${chunkCount} chunks in ${streamDuration}ms (TTFT: ${ttft}ms), content: ${contentBuffer.length} chars, reasoning: ${reasoningBuffer.length} chars, tool_calls: ${toolCallAccumulators.size}`);

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

      // Strip inline <think> tags before adding to messages array
      const { cleaned: cleanContent, thinking: inlineThink } = stripThinkTags(contentBuffer);
      if (inlineThink) {
        reasoningBuffer += (reasoningBuffer ? '\n' : '') + inlineThink;
      }

      // Reconstruct the assistant message for the messages array
      const assistantMessage: any = {
        role: 'assistant' as const,
        content: cleanContent || null,
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
        // Strip inline <think>...</think> tags that some models embed in content
        const { cleaned: strippedContent, thinking: inlineThinking } = stripThinkTags(contentBuffer);
        if (inlineThinking) {
          bufLog(`Stripped ${contentBuffer.length - strippedContent.length} chars of inline <think> tags from response`);
          // Surface extracted thinking as a thinking event
          thinkingBuffer += (thinkingBuffer ? '\n' : '') + inlineThinking;
          const snippet = thinkingBuffer.slice(-THINKING_SNAPSHOT_LENGTH);
          yield { type: 'thinking', content: snippet };
        }

        bufLog(`Final response: ${strippedContent.length} chars (total reasoning: ${(reasoningBuffer.length + inlineThinking.length)} chars, iterations: ${iterations})`);
        // Drain log buffer before final result
        while (logBuffer.length > 0) {
          yield { type: 'adapter_stderr', message: logBuffer.shift()! };
        }
        if (strippedContent) {
          yield { type: 'result', result: strippedContent };
        } else {
          bufLog('Warning: empty final response (no content and no tool calls)');
        }
        break;
      }

      // Execute each tool call
      bufLog(`Executing ${toolCalls.length} tool call(s): [${toolCalls.map(tc => tc.function.name).join(', ')}]`);
      // Drain log buffer before tool execution
      while (logBuffer.length > 0) {
        yield { type: 'adapter_stderr', message: logBuffer.shift()! };
      }
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        bufLog(`Tool call: ${toolName}(${toolCall.function.arguments.slice(0, 300)})`);
        yield {
          type: 'tool_start',
          toolName,
          preview: toolCall.function.arguments.slice(0, 200),
        };

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (parseErr) {
          bufLog(`Tool args parse error for ${toolName}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
          args = {};
        }

        const toolStartTime = Date.now();
        const toolResult = await executeNanoToolFull(toolName, args, input.ipcContext);
        const toolDuration = Date.now() - toolStartTime;

        bufLog(`Tool result: ${toolName} ${toolResult.isError ? 'ERROR' : 'OK'} in ${toolDuration}ms, ${toolResult.content.length} chars${toolResult.imageBase64 ? ', +image' : ''}`);
        if (toolResult.isError) {
          bufLog(`Tool error detail: ${toolResult.content.slice(0, 500)}`);
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
        bufLog(`${consecutiveToolErrors} consecutive tool errors, injecting guidance`);
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
