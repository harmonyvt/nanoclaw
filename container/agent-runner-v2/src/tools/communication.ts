/**
 * Communication tools: send_message, send_file, send_voice.
 */

import { z } from 'zod';
import fs from 'fs';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import { writeIpcFile, MESSAGES_DIR, requestHost } from './utils.js';

export const communicationTools: NanoTool[] = [
  {
    name: 'send_message',
    description:
      'Send a message to the current chat. Use this to proactively share information or updates.',
    schema: z.object({
      text: z.string().describe('The message text to send'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const viaRpc = yield* requestHost('telegram.sendMessage', {
          chatJid: ctx.chatJid,
          text: args.text as string,
          sourceGroup: ctx.groupFolder,
        });

        if (viaRpc) {
          const rpc = viaRpc as { message?: string };
          return { content: rpc.message || 'Message sent.' };
        }

        const data = {
          type: 'message',
          chatJid: ctx.chatJid,
          text: args.text as string,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };

        const filename = writeIpcFile(MESSAGES_DIR, data);
        return { content: `Message queued for delivery (${filename})` };
      }),
  },

  {
    name: 'send_file',
    description:
      'Send a file/document to the current chat via Telegram. Use this to share downloaded files, generated documents, or any file accessible to the agent.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to the file inside the container (e.g., "/workspace/group/media/report.pdf")',
        ),
      caption: z
        .string()
        .optional()
        .describe('Optional caption to send with the file'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const filePath = args.path as string;

        if (!fs.existsSync(filePath)) {
          return { content: `File not found: ${filePath}`, isError: true as const };
        }

        const viaRpc = yield* requestHost('telegram.sendFile', {
          chatJid: ctx.chatJid,
          filePath,
          caption: (args.caption as string) || null,
          sourceGroup: ctx.groupFolder,
        });

        if (viaRpc) {
          const rpc = viaRpc as { message?: string };
          return { content: rpc.message || `File sent: ${filePath}` };
        }

        const data = {
          type: 'file',
          chatJid: ctx.chatJid,
          filePath,
          caption: (args.caption as string) || null,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };

        const filename = writeIpcFile(MESSAGES_DIR, data);
        return { content: `File queued for delivery (${filename}): ${filePath}` };
      }),
  },

  {
    name: 'send_voice',
    description: `Send a voice message to the current chat using Qwen3-TTS text-to-speech. The text will be synthesized into speech using the group's configured voice and sent as a Telegram voice message.

Voice characteristics come from /workspace/group/voice_profile.json. If no voice profile exists, a default voice is used. Use /design_voice to customize the voice, or create the profile when setting up SOUL.md.

Keep text under ~500 chars for best quality. The emotion parameter is optional and only used with the legacy Freya TTS fallback.`,
    schema: z.object({
      text: z.string().describe('The text to speak as a voice message'),
      emotion: z
        .string()
        .optional()
        .describe(
          'Emotion for the voice (e.g. "happy", "sad:2", "whisper:3"). Auto-detected if omitted.',
        ),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const viaRpc = yield* requestHost('telegram.sendVoice', {
          chatJid: ctx.chatJid,
          text: args.text as string,
          emotion: (args.emotion as string) || null,
          sourceGroup: ctx.groupFolder,
        });

        if (viaRpc) {
          const rpc = viaRpc as { message?: string };
          return { content: rpc.message || 'Voice message sent.' };
        }

        const data = {
          type: 'voice',
          chatJid: ctx.chatJid,
          text: args.text as string,
          emotion: (args.emotion as string) || null,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };

        const filename = writeIpcFile(MESSAGES_DIR, data);
        return { content: `Voice message queued for delivery (${filename})` };
      }),
  },
];
