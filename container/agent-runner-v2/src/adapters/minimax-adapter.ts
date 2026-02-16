/**
 * MiniMax Adapter for NanoClaw v2.
 *
 * Uses the Anthropic SDK pointed at MiniMax's Anthropic-compatible endpoint
 * (https://api.minimax.io/anthropic) with MiniMax-M2.1. Implements an agentic
 * loop with tool calling, reusing the NanoClaw tool registry.
 *
 * Stateless: conversation history is provided in the prompt as XML.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  ToolUseBlock,
  TextBlock,
  ThinkingBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { Effect, Stream, Layer } from 'effect';
import type { AgentEvent } from '../schemas/AgentEvent.js';
import { AdapterError } from '../errors/index.js';
import { HostBridge } from '../services/HostBridge.js';
import { Cancellation } from '../services/Cancellation.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import { buildSystemPrompt, parseConversationXml } from './openai-adapter.js';
import { executeNanoTool } from './openai-tools.js';
import { ALL_TOOLS } from '../tools/index.js';
import type { AdapterInput, ProviderAdapter } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 8192;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string): void {
  process.stderr.write(`[minimax-adapter] ${message}\n`);
}

// ─── Tool Schema Conversion ─────────────────────────────────────────────────

function buildAnthropicTools(): Tool[] {
  return ALL_TOOLS.map((t) => {
    const jsonSchema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    const { $schema: _, ...input_schema } = jsonSchema;

    return {
      name: t.name,
      description: t.description,
      input_schema: input_schema as Tool['input_schema'],
    };
  });
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class MinimaxAdapter implements ProviderAdapter {
  run(
    input: AdapterInput,
  ): Stream.Stream<AgentEvent, AdapterError, HostBridge | ToolRegistry | Cancellation> {
    return Stream.fromEffect(
      Effect.gen(function* () {
        const bridge = yield* HostBridge;
        const bridgeLayer = Layer.succeed(HostBridge, bridge);
        const cancellation = yield* Cancellation;
        return { bridgeLayer, cancellation };
      }),
    ).pipe(
      Stream.flatMap(({ bridgeLayer, cancellation }) =>
        Stream.async<AgentEvent, AdapterError>((emit) => {
          void (async () => {
            try {
              const client = new Anthropic({
                apiKey: process.env.MINIMAX_API_KEY,
                baseURL:
                  input.baseUrl || 'https://api.minimax.io/anthropic',
              });

              const model = input.model || 'MiniMax-M2.1';
              emit.single({
                type: 'session_init',
                sessionId: `minimax-${Date.now()}`,
              });

              const { conversationMessages, remainingPrompt } =
                parseConversationXml(input.prompt);

              const systemPrompt = buildSystemPrompt(input);
              const tools = buildAnthropicTools();

              const messages: MessageParam[] = [];

              for (const msg of conversationMessages) {
                if (msg.role === 'assistant') {
                  messages.push({
                    role: 'assistant',
                    content: msg.content,
                  });
                } else {
                  const prefix = msg.senderName
                    ? `${msg.senderName}: `
                    : '';
                  messages.push({
                    role: 'user',
                    content: `${prefix}${msg.content}`,
                  });
                }
              }

              if (remainingPrompt) {
                messages.push({ role: 'user', content: remainingPrompt });
              }

              let iterations = 0;
              let finalResult: string | null = null;

              while (iterations < MAX_ITERATIONS) {
                iterations++;

                // Check for cancellation
                const cancelled = await Effect.runPromise(
                  cancellation.isCancelled,
                );
                if (cancelled) {
                  log('Cancel detected, stopping MiniMax loop');
                  if (finalResult)
                    emit.single({ type: 'result', result: finalResult });
                  emit.end();
                  return;
                }

                log(
                  `Iteration ${iterations}, sending ${messages.length} messages to ${model}`,
                );

                const response = await client.messages.create({
                  model,
                  max_tokens: DEFAULT_MAX_TOKENS,
                  system: systemPrompt,
                  messages,
                  tools: tools.length > 0 ? tools : undefined,
                });

                const textParts: string[] = [];
                const toolUseBlocks: ToolUseBlock[] = [];

                for (const block of response.content) {
                  if (block.type === 'text') {
                    textParts.push((block as TextBlock).text);
                  } else if (block.type === 'tool_use') {
                    toolUseBlocks.push(block as ToolUseBlock);
                  } else if (block.type === 'thinking') {
                    const thinkingContent =
                      (block as ThinkingBlock).thinking || '';
                    if (thinkingContent) {
                      emit.single({
                        type: 'thinking',
                        content: thinkingContent.slice(-4000),
                      });
                    }
                  }
                }

                if (textParts.length > 0) {
                  finalResult = textParts.join('');
                }

                // No tool calls -> done
                if (
                  toolUseBlocks.length === 0 ||
                  response.stop_reason === 'end_turn'
                ) {
                  if (finalResult) {
                    emit.single({ type: 'result', result: finalResult });
                  }
                  messages.push({
                    role: 'assistant',
                    content: response.content as ContentBlockParam[],
                  });
                  break;
                }

                messages.push({
                  role: 'assistant',
                  content: response.content as ContentBlockParam[],
                });

                const toolResults: ToolResultBlockParam[] = [];

                for (const toolUse of toolUseBlocks) {
                  emit.single({
                    type: 'tool_start',
                    toolName: toolUse.name,
                    preview: JSON.stringify(toolUse.input).slice(0, 200),
                  });

                  const args = (toolUse.input || {}) as Record<
                    string,
                    unknown
                  >;
                  const result = await executeNanoTool(
                    toolUse.name,
                    args,
                    input.ipcContext,
                    bridgeLayer,
                  );

                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: result,
                  });
                }

                messages.push({
                  role: 'user',
                  content: toolResults,
                });
              }

              if (iterations >= MAX_ITERATIONS) {
                log(`Hit max iterations (${MAX_ITERATIONS}), stopping`);
              }

              emit.end();
            } catch (err) {
              emit.fail(
                new AdapterError({
                  provider: 'minimax',
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
