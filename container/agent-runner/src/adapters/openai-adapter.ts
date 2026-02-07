/**
 * OpenAI Adapter for NanoClaw.
 *
 * Implements the ProviderAdapter interface using the OpenAI Chat Completions API
 * with function calling. Manages an agentic loop: sends messages to the model,
 * executes any tool calls via the NanoClaw tool registry, feeds results back,
 * and repeats until the model produces a final text response (no tool calls).
 *
 * Conversation history is persisted between invocations via openai-session.ts.
 */

import fs from 'fs';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';
import { buildOpenAITools, executeNanoTool } from './openai-tools.js';
import {
  loadHistory,
  saveHistory,
  generateSessionId,
  type SessionMessage,
} from './openai-session.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import { writeCapabilityRequest } from '../tool-registry.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum agentic loop iterations to prevent runaway tool-calling */
export const MAX_ITERATIONS = 50;

type OpenAIToolCall = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
};

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: OpenAIMessage;
  }>;
};

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[openai-adapter] ${message}`);
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
    const model = input.model || 'gpt-4o';

    const sessionId = input.sessionId || generateSessionId();
    yield { type: 'session_init', sessionId };

    const history = loadHistory(input.sessionId);

    const systemPrompt = buildSystemPrompt(input);
    const tools = buildOpenAITools();

    const restoredHistory = history.filter((m) => m.role !== 'system') as OpenAIMessage[];

    const messages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...restoredHistory,
      { role: 'user', content: input.prompt },
    ];

    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      log(`Iteration ${iterations}, sending ${messages.length} messages to ${model}`);

      const responsePayload = await writeCapabilityRequest(
        'openai_chat_completion',
        {
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        },
        120000,
      );

      if (responsePayload.status === 'error') {
        throw new Error(
          responsePayload.error || 'OpenAI gateway returned an unknown error',
        );
      }

      const response = responsePayload.result as OpenAIChatCompletion;
      if (!response?.choices || response.choices.length === 0) {
        throw new Error('OpenAI gateway returned no choices');
      }

      const choice = response.choices[0];
      if (!choice?.message) {
        throw new Error('OpenAI gateway returned malformed choice message');
      }

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // No tool calls = final response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        if (typeof assistantMessage.content === 'string' && assistantMessage.content) {
          yield { type: 'result', result: assistantMessage.content };
        }
        break;
      }

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function?.name || 'unknown';
        const preview = (toolCall.function?.arguments || '').slice(0, 200);
        yield {
          type: 'tool_start',
          toolName,
          preview,
        };

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          args = {};
        }

        const result = await executeNanoTool(toolName, args, input.ipcContext);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    if (iterations > MAX_ITERATIONS) {
      log(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
    }

    // Save conversation history (exclude system prompt, we rebuild it each time).
    // Cast to SessionMessage[] -- the session layer uses loose types for serialization.
    const toSave = messages.filter((m) => m.role !== 'system') as unknown as SessionMessage[];
    saveHistory(sessionId, toSave);
  }
}
