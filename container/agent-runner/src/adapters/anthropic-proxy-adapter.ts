/**
 * Anthropic proxy adapter for secretless mode.
 *
 * The container never holds Anthropic or Claude OAuth credentials.
 * All model calls are proxied to the host capability gateway.
 */

import { z } from 'zod';

import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';
import { NANOCLAW_TOOLS, writeCapabilityRequest } from '../tool-registry.js';
import { executeNanoTool } from './openai-tools.js';
import {
  loadHistory,
  saveHistory,
  type SessionMessage,
} from './openai-session.js';
import { buildSystemPrompt } from './openai-adapter.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_ITERATIONS = 50;
const DEFAULT_SESSIONS_DIR = '/workspace/group/.anthropic-sessions';

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicTextBlock = {
  type: 'text';
  text: string;
};

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
};

function log(message: string): void {
  console.error(`[anthropic-proxy-adapter] ${message}`);
}

function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `anthropic-${timestamp}-${random}`;
}

function buildAnthropicTools(): AnthropicTool[] {
  return NANOCLAW_TOOLS.map((tool) => {
    const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    const { $schema: _, ...inputSchema } = jsonSchema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema,
    };
  });
}

export class AnthropicProxyAdapter implements ProviderAdapter {
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    const model = input.model || DEFAULT_MODEL;
    const sessionId = input.sessionId || generateSessionId();
    yield { type: 'session_init', sessionId };

    const restoredHistory = loadHistory(
      input.sessionId,
      DEFAULT_SESSIONS_DIR,
    ) as AnthropicMessage[];

    const messages: AnthropicMessage[] = [
      ...restoredHistory,
      { role: 'user', content: input.prompt },
    ];

    const systemPrompt = buildSystemPrompt(input);
    const tools = buildAnthropicTools();

    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      log(`Iteration ${iterations}, sending ${messages.length} messages to ${model}`);

      const responsePayload = await writeCapabilityRequest(
        'anthropic_messages',
        {
          model,
          system: systemPrompt,
          messages,
          max_tokens: 4096,
          tools: tools.length > 0 ? tools : undefined,
        },
        120000,
      );

      if (responsePayload.status === 'error') {
        throw new Error(
          responsePayload.error || 'Anthropic gateway returned an unknown error',
        );
      }

      const response = responsePayload.result as AnthropicMessagesResponse;
      const contentBlocks = Array.isArray(response?.content) ? response.content : [];
      messages.push({ role: 'assistant', content: contentBlocks });

      const textParts = contentBlocks
        .filter((block): block is AnthropicTextBlock => block.type === 'text')
        .map((block) => block.text)
        .filter((text) => text.trim().length > 0);

      const toolUses = contentBlocks.filter(
        (block): block is AnthropicToolUseBlock =>
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string',
      );

      if (toolUses.length === 0) {
        if (textParts.length > 0) {
          yield { type: 'result', result: textParts.join('\n') };
        }
        break;
      }

      for (const toolUse of toolUses) {
        const toolName = toolUse.name || 'unknown';
        yield {
          type: 'tool_start',
          toolName,
          preview: JSON.stringify(toolUse.input || {}).slice(0, 200),
        };

        const args =
          toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
        const result = await executeNanoTool(toolName, args, input.ipcContext);

        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            },
          ],
        });
      }
    }

    if (iterations > MAX_ITERATIONS) {
      log(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
    }

    saveHistory(
      sessionId,
      messages as unknown as SessionMessage[],
      DEFAULT_SESSIONS_DIR,
    );
  }
}
