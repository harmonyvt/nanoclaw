/**
 * Claude Agent SDK wrapper for NanoClaw tools.
 * Maps provider-agnostic NANOCLAW_TOOLS into Claude SDK MCP tools.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { MESSAGES_DIR, NANOCLAW_TOOLS, writeIpcFile } from './tool-registry.js';
import type { IpcMcpContext } from './types.js';

export type { IpcMcpContext } from './types.js';

export function createIpcMcp(ctx: IpcMcpContext) {
  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      ...NANOCLAW_TOOLS.map((t) =>
        tool(
          t.name,
          t.description,
          t.schema.shape,
          async (args: Record<string, unknown>) => {
            const result = await t.handler(args, ctx);
            return {
              content: [{ type: 'text' as const, text: result.content }],
              isError: result.isError,
            };
          },
        ),
      ),
      tool(
        'send_voice',
        'Send a voice message to the current chat using host-side TTS.',
        {
          text: z.string().describe('The text to speak as a voice message'),
          emotion: z
            .string()
            .optional()
            .describe(
              'Optional emotion hint, for example "happy", "sad:2", "whisper:3".',
            ),
        },
        async (args: { text: string; emotion?: string }) => {
          const payload = {
            type: 'voice',
            chatJid: ctx.chatJid,
            text: args.text,
            emotion: args.emotion || null,
            groupFolder: ctx.groupFolder,
            timestamp: new Date().toISOString(),
          };
          const filename = writeIpcFile(MESSAGES_DIR, payload);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Voice message queued for delivery (${filename})`,
              },
            ],
          };
        },
      ),
    ],
  });
}
