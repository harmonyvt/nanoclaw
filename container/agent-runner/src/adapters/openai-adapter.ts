/**
 * OpenAI Adapter for NanoClaw.
 *
 * Implements the ProviderAdapter interface using the OpenAI Chat Completions API
 * with function calling. Manages an agentic loop: sends messages to the model,
 * executes any tool calls via the NanoClaw tool registry, feeds results back,
 * and repeats until the model produces a final text response (no tool calls).
 *
 * Stateless: conversation history is provided in the prompt (built from SQLite
 * on the host side as XML). This adapter parses the XML into proper role-based
 * messages for better OpenAI model quality.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import fs from 'fs';
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';

/** Extends the SDK message type for o-series reasoning content (not yet in official types) */
interface ChatCompletionMessageWithReasoning extends ChatCompletionMessage {
  reasoning_content?: string;
}
import { buildOpenAITools, executeNanoTool } from './openai-tools.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import { isCancelled } from '../cancel.js';

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[openai-adapter] ${message}`);
}

// ─── XML Conversation Parser ────────────────────────────────────────────────

export interface ParsedConversationMessage {
  role: 'user' | 'assistant';
  senderName: string;
  content: string;
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

    const role = roleMatch?.[1] === 'assistant' ? 'assistant' as const : 'user' as const;
    const senderName = senderMatch?.[1] || 'User';

    // Unescape XML entities
    const unescaped = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');

    conversationMessages.push({ role, senderName, content: unescaped });
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
        messages.push({ role: 'user', content: `${prefix}${msg.content}` });
      }
    }

    // Add any remaining prompt content (e.g., <soul>, <skill>, <memory> blocks)
    if (remainingPrompt) {
      messages.push({ role: 'user', content: remainingPrompt });
    }

    log(`Starting with ${messages.length} messages (${conversationMessages.length} from history)`);

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
      const { reasoning_content: reasoning } = assistantMessage as ChatCompletionMessageWithReasoning;
      if (reasoning && input.enableThinking !== false) {
        const snippet = reasoning.slice(-4000);
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
  }
}
