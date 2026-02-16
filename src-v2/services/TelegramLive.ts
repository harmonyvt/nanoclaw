/**
 * TelegramLive — wraps grammY bot as an Effect Layer.
 * Exposes incoming messages as an Effect Stream.
 *
 * Port of src/telegram.ts (v1) — core connectivity, send/edit/delete, formatMarkdown.
 */

import { Bot, InputFile } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import type { RunnerHandle } from '@grammyjs/runner';
import fs from 'fs';
import { Effect, Layer, Stream } from 'effect';

import { AppConfig } from '../config.js';
import {
  TelegramError,
  TelegramConnectionError,
  TelegramSendError,
} from '../errors.js';
import { Telegram } from './Telegram.js';
import type { IncomingMessage, TelegramService } from './Telegram.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTelegramChatId(numericId: number): string {
  return `telegram:${numericId}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Code blocks
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) =>
    `<pre><code>${escapeHtml(code.trim())}</code></pre>`,
  );
  result = result.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${escapeHtml(code.trim())}</code></pre>`,
  );

  // Inline code
  result = result.replace(/`([^`\n]+)`/g, (_, code) =>
    `<code>${escapeHtml(code)}</code>`,
  );

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) =>
    `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`,
  );

  // Bold
  result = result.replace(
    /\*\*([^*\n]+?)\*\*/g,
    (_, t) => `<b>${escapeHtml(t)}</b>`,
  );
  result = result.replace(
    /__([^_\n]+?)__/g,
    (_, t) => `<b>${escapeHtml(t)}</b>`,
  );

  // Italic
  result = result.replace(
    /\*([^*\n]+?)\*/g,
    (_, t) => `<i>${escapeHtml(t)}</i>`,
  );
  result = result.replace(
    /_([^_\n]+?)_/g,
    (_, t) => `<i>${escapeHtml(t)}</i>`,
  );

  // Headings to bold
  result = result.replace(
    /^### (.+)$/gm,
    (_, t) => `<b>${escapeHtml(t)}</b>`,
  );
  result = result.replace(
    /^## (.+)$/gm,
    (_, t) => `<b>${escapeHtml(t)}</b>`,
  );
  result = result.replace(
    /^# (.+)$/gm,
    (_, t) => `<b>${escapeHtml(t)}</b>`,
  );

  // Bullet lists
  result = result.replace(/^[-*+] (.+)$/gm, '• $1');

  // Escape remaining HTML entities in text segments (skip existing tags)
  const lines = result.split('\n');
  const processedLines = lines.map((line) => {
    const parts = line.split(/(<[^>]+>)/);
    return parts
      .map((part) => {
        if (part.startsWith('<') && part.endsWith('>')) return part;
        return part
          .replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      })
      .join('');
  });

  return processedLines.join('\n');
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const TelegramLive: Layer.Layer<
  Telegram,
  TelegramConnectionError,
  AppConfig
> = Layer.scoped(
  Telegram,
  Effect.gen(function* () {
    const config = yield* AppConfig;

    if (!config.telegramBotToken) {
      return yield* Effect.fail(
        new TelegramConnectionError({
          message: 'TELEGRAM_BOT_TOKEN is required',
        }),
      );
    }

    const bot = new Bot(config.telegramBotToken);

    // Per-chat sequential ordering
    bot.use(
      sequentialize((ctx) => {
        const chatId = ctx.chat?.id.toString();
        return chatId ? [chatId] : [];
      }),
    );

    // Track runner for cleanup
    let runnerHandle: RunnerHandle | undefined;

    // Register scope finalizer
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: async () => {
          if (runnerHandle) {
            runnerHandle.stop();
          }
          await bot.stop();
        },
        catch: () =>
          new TelegramError({ message: 'Failed to stop Telegram bot' }),
      }).pipe(Effect.ignore),
    );

    const service: TelegramService = {
      connect: Effect.gen(function* () {
        return Stream.async<IncomingMessage, TelegramError>((emit) => {
          // Text messages
          bot.on('message:text', (ctx) => {
            if (!ctx.chat || !ctx.from || !ctx.message) return;
            const chatJid = makeTelegramChatId(ctx.chat.id);
            const msg: IncomingMessage = {
              id: ctx.message.message_id.toString(),
              chatJid,
              sender: ctx.from.id.toString(),
              senderName: `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`,
              content: ctx.message.text,
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
            };
            emit.single(msg);
          });

          // Voice messages
          bot.on('message:voice', (ctx) => {
            if (!ctx.chat || !ctx.from || !ctx.message) return;
            const chatJid = makeTelegramChatId(ctx.chat.id);
            const msg: IncomingMessage = {
              id: ctx.message.message_id.toString(),
              chatJid,
              sender: ctx.from.id.toString(),
              senderName: `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`,
              content: '[voice message]',
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
              mediaType: 'voice',
            };
            emit.single(msg);
          });

          // Photo messages
          bot.on('message:photo', (ctx) => {
            if (!ctx.chat || !ctx.from || !ctx.message) return;
            const chatJid = makeTelegramChatId(ctx.chat.id);
            const msg: IncomingMessage = {
              id: ctx.message.message_id.toString(),
              chatJid,
              sender: ctx.from.id.toString(),
              senderName: `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`,
              content: ctx.message.caption || '[photo]',
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
              mediaType: 'photo',
            };
            emit.single(msg);
          });

          // Document messages
          bot.on('message:document', (ctx) => {
            if (!ctx.chat || !ctx.from || !ctx.message) return;
            const chatJid = makeTelegramChatId(ctx.chat.id);
            const msg: IncomingMessage = {
              id: ctx.message.message_id.toString(),
              chatJid,
              sender: ctx.from.id.toString(),
              senderName: `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`,
              content:
                ctx.message.caption ||
                ctx.message.document?.file_name ||
                '[document]',
              timestamp: new Date(ctx.message.date * 1000).toISOString(),
              mediaType: 'document',
            };
            emit.single(msg);
          });

          // Start the bot via grammY runner (non-blocking)
          runnerHandle = run(bot);
        });
      }),

      sendMessage: (chatJid, text) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            await bot.api.sendMessage(numericId, text, {
              parse_mode: 'HTML',
            });
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendMessage failed: ${err}`,
              chatJid,
            }),
        }),

      sendMessageWithId: (chatJid, text) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const msg = await bot.api.sendMessage(numericId, text, {
              parse_mode: 'HTML',
            });
            return msg.message_id;
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendMessageWithId failed: ${err}`,
              chatJid,
            }),
        }),

      editMessageText: (chatJid, messageId, text) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            await bot.api.editMessageText(numericId, messageId, text, {
              parse_mode: 'HTML',
            });
            return true;
          },
          catch: (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            // "message is not modified" is a soft failure
            if (errMsg.includes('message is not modified')) {
              // Return succeed(false) in catch is not possible, so throw tagged
              return new TelegramSendError({
                message: 'not_modified',
                chatJid,
              });
            }
            return new TelegramSendError({
              message: `editMessageText failed: ${errMsg}`,
              chatJid,
            });
          },
        }).pipe(
          Effect.catchTag('TelegramSendError', (e) =>
            e.message === 'not_modified'
              ? Effect.succeed(false)
              : Effect.fail(e),
          ),
        ),

      deleteMessage: (chatJid, messageId) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            await bot.api.deleteMessage(numericId, messageId);
          },
          catch: (err) =>
            new TelegramSendError({
              message: `deleteMessage failed: ${err}`,
              chatJid,
            }),
        }),

      sendPhoto: (chatJid, filePath, caption) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const inputFile = new InputFile(fs.createReadStream(filePath));
            const msg = await bot.api.sendPhoto(numericId, inputFile, {
              caption,
            });
            return msg.message_id;
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendPhoto failed: ${err}`,
              chatJid,
            }),
        }),

      editPhoto: (chatJid, messageId, filePath, caption) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const inputFile = new InputFile(fs.createReadStream(filePath));
            await bot.api.editMessageMedia(
              numericId,
              messageId,
              {
                type: 'photo',
                media: inputFile,
                caption,
              },
            );
            return true;
          },
          catch: () =>
            new TelegramSendError({
              message: 'editPhoto failed',
              chatJid,
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(false))),

      sendDocument: (chatJid, filePath, caption) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const inputFile = new InputFile(fs.createReadStream(filePath));
            await bot.api.sendDocument(numericId, inputFile, { caption });
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendDocument failed: ${err}`,
              chatJid,
            }),
        }),

      sendVoice: (chatJid, filePath) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const inputFile = new InputFile(fs.createReadStream(filePath));
            await bot.api.sendVoice(numericId, inputFile);
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendVoice failed: ${err}`,
              chatJid,
            }),
        }),

      sendStatusMessage: (chatJid, text) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            const msg = await bot.api.sendMessage(numericId, `<i>${escapeHtml(text)}</i>`, {
              parse_mode: 'HTML',
            });
            return msg.message_id;
          },
          catch: (err) =>
            new TelegramSendError({
              message: `sendStatusMessage failed: ${err}`,
              chatJid,
            }),
        }),

      editStatusMessage: (chatJid, messageId, text) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            await bot.api.editMessageText(
              numericId,
              messageId,
              `<i>${escapeHtml(text)}</i>`,
              { parse_mode: 'HTML' },
            );
            return true;
          },
          catch: () =>
            new TelegramSendError({
              message: 'editStatusMessage failed',
              chatJid,
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(false))),

      setTyping: (chatJid) =>
        Effect.tryPromise({
          try: async () => {
            const numericId = parseInt(chatJid.replace('telegram:', ''), 10);
            await bot.api.sendChatAction(numericId, 'typing');
          },
          catch: (err) =>
            new TelegramSendError({
              message: `setTyping failed: ${err}`,
              chatJid,
            }),
        }),

      stop: Effect.tryPromise({
        try: async () => {
          if (runnerHandle) runnerHandle.stop();
          await bot.stop();
        },
        catch: () =>
          new TelegramError({ message: 'Failed to stop Telegram bot' }),
      }),
    };

    return service;
  }),
);
