/**
 * MiniMax Adapter for NanoClaw.
 *
 * Uses the Anthropic SDK pointed at MiniMax's Anthropic-compatible endpoint
 * (https://api.minimax.io/anthropic) with MiniMax-M2.1. Implements an agentic
 * loop with tool calling, reusing the NanoClaw tool registry.
 *
 * Pattern mirrors the OpenAI adapter: system prompt, tool-calling loop,
 * session persistence via openai-session.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';
import { buildSystemPrompt } from './openai-adapter.js';
import { executeNanoTool } from './openai-tools.js';
import {
  loadHistory,
  saveHistory,
  type SessionMessage,
} from './openai-session.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import { isCancelled } from '../cancel.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 8192;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[minimax-adapter] ${message}`);
}

// ─── Tool Schema Conversion ─────────────────────────────────────────────────

/**
 * Convert NanoClaw tools to Anthropic tool format.
 * Uses Zod v4's z.toJSONSchema() and maps to { name, description, input_schema }.
 */
function buildAnthropicTools(): Tool[] {
  return NANOCLAW_TOOLS.map((t) => {
    const jsonSchema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    const { $schema: _, ...input_schema } = jsonSchema;

    return {
      name: t.name,
      description: t.description,
      input_schema: input_schema as Tool['input_schema'],
    };
  });
}

// ─── Session Helpers ────────────────────────────────────────────────────────

const SESSIONS_DIR = '/workspace/group/.minimax-sessions';

function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Convert stored session messages back to Anthropic MessageParam[].
 * Only restores user/assistant messages with compatible content shapes.
 */
function sessionToMessages(history: SessionMessage[]): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const msg of history) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({
        role: msg.role,
        content: msg.content as MessageParam['content'],
      });
    }
  }
  return messages;
}

/**
 * Convert Anthropic MessageParam[] to generic session messages for persistence.
 */
function messagesToSession(messages: MessageParam[]): SessionMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content as SessionMessage['content'],
  }));
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class MinimaxAdapter implements ProviderAdapter {
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    const client = new Anthropic({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimax.io/anthropic',
    });

    const model = input.model || 'MiniMax-M2.1';
    const sessionId = input.sessionId || generateSessionId();
    yield { type: 'session_init', sessionId };

    const history = loadHistory(sessionId, SESSIONS_DIR);
    const systemPrompt = buildSystemPrompt(input);
    const tools = buildAnthropicTools();

    // Restore previous messages (excluding system, we pass it separately)
    const restoredHistory = sessionToMessages(history);

    // Build messages array: history + new user message
    const messages: MessageParam[] = [
      ...restoredHistory,
      { role: 'user', content: input.prompt },
    ];

    let iterations = 0;
    let finalResult: string | null = null;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (isCancelled()) {
        log('Cancel detected, stopping MiniMax loop');
        if (finalResult) yield { type: 'result', result: finalResult };
        return;
      }

      log(`Iteration ${iterations}, sending ${messages.length} messages to ${model}`);

      const response = await client.messages.create({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      // Collect text and tool_use blocks from response
      const textParts: string[] = [];
      const toolUseBlocks: ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push((block as TextBlock).text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block as ToolUseBlock);
        } else if (block.type === 'thinking') {
          const thinkingContent = (block as any).thinking || '';
          if (thinkingContent) {
            yield { type: 'thinking', content: thinkingContent.slice(-4000) };
          }
        }
      }

      if (textParts.length > 0) {
        finalResult = textParts.join('');
      }

      // No tool calls → done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        if (finalResult) {
          yield { type: 'result', result: finalResult };
        }
        // Append assistant message to history for saving
        messages.push({
          role: 'assistant',
          content: response.content as ContentBlockParam[],
        });
        break;
      }

      // Append assistant message (with tool_use blocks) to conversation
      messages.push({
        role: 'assistant',
        content: response.content as ContentBlockParam[],
      });

      // Execute each tool call and build tool_result blocks
      const toolResults: ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        yield {
          type: 'tool_start',
          toolName: toolUse.name,
          preview: JSON.stringify(toolUse.input).slice(0, 200),
        };

        const args = (toolUse.input || {}) as Record<string, unknown>;
        const result = await executeNanoTool(toolUse.name, args, input.ipcContext);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Append tool results as a user message (Anthropic format)
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    if (iterations >= MAX_ITERATIONS) {
      log(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
    }

    // Save conversation history
    saveHistory(sessionId, messagesToSession(messages), SESSIONS_DIR);
  }
}
