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

import OpenAI from 'openai';
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
import { isCancelled } from '../cancel.js';

// ─── Constants ──────────────────────────────────────────────────────────────


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
    const client = new OpenAI(); // reads OPENAI_API_KEY from env
    const model = input.model || 'gpt-4o';

    const sessionId = input.sessionId || generateSessionId();
    yield { type: 'session_init', sessionId };

    const history = loadHistory(input.sessionId);

    const systemPrompt = buildSystemPrompt(input);
    const tools = buildOpenAITools();

    // History messages are stored as SessionMessage (loose types for serialization).
    // Cast to ChatCompletionMessageParam -- the shapes are compatible at runtime.
    const restoredHistory = history.filter(
      (m) => m.role !== 'system',
    ) as unknown as OpenAI.ChatCompletionMessageParam[];

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...restoredHistory,
      { role: 'user', content: input.prompt },
    ];

    let iterations = 0;
    while (true) {
      iterations++;
      // Check for user interrupt
      if (isCancelled()) {
        log('Cancel detected, stopping OpenAI loop');
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        const partial = lastAssistant && 'content' in lastAssistant ? String(lastAssistant.content) : null;
        if (partial) yield { type: 'result', result: partial };
        return;
      }

      log(`Iteration ${iterations}, sending ${messages.length} messages to ${model}`);

      const response = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      const choice = response.choices[0];
      if (!choice) break;

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // Capture reasoning content from o-series models (o1, o3, etc.)
      const reasoning = (assistantMessage as unknown as Record<string, unknown>).reasoning_content;
      if (reasoning && typeof reasoning === 'string') {
        const snippet = reasoning.length > 200 ? '...' + reasoning.slice(-200) : reasoning;
        yield { type: 'thinking', content: snippet };
      }

      // No tool calls = final response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        if (assistantMessage.content) {
          yield { type: 'result', result: assistantMessage.content };
        }
        break;
      }

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
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

        const result = await executeNanoTool(toolName, args, input.ipcContext);

        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }


    // Save conversation history (exclude system prompt, we rebuild it each time).
    // Cast to SessionMessage[] -- the session layer uses loose types for serialization.
    const toSave = messages.filter((m) => m.role !== 'system') as unknown as SessionMessage[];
    saveHistory(sessionId, toSave);
  }
}
