/**
 * TelegramConsoleLive — local terminal simulation of Telegram I/O.
 *
 * Lets developers run the real v2 runtime without Telegram by typing
 * messages in stdin and receiving responses in stdout.
 */

import readline from 'readline';
import { Effect, Layer, Queue, Ref, Stream } from 'effect';

import { AppConfig } from '../config.js';
import { Telegram } from './Telegram.js';
import type { IncomingMessage, TelegramService } from './Telegram.js';

function normalizeChatJid(input: string): string {
  const value = input.trim();
  if (!value) return 'telegram:1';
  return value.startsWith('telegram:') ? value : `telegram:${value}`;
}

export const TelegramConsoleLive: Layer.Layer<Telegram, never, AppConfig> =
  Layer.scoped(
    Telegram,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      const incoming = yield* Queue.unbounded<IncomingMessage>();
      const currentChatRef = yield* Ref.make(
        normalizeChatJid(config.telegramOwnerId || '1'),
      );
      const currentSenderNameRef = yield* Ref.make('Local User');
      const nextIncomingIdRef = yield* Ref.make(1);
      const nextOutgoingIdRef = yield* Ref.make(1);

      let rl: readline.Interface | null = null;
      let started = false;

      const printAndPrompt = (text: string): void => {
        process.stdout.write(`${text}\n`);
        rl?.prompt();
      };

      const printHelp = (): void => {
        printAndPrompt('[sim] Commands:');
        printAndPrompt('[sim]   /help              Show this help');
        printAndPrompt('[sim]   /chat <id|jid>     Switch active chat (default: owner)');
        printAndPrompt('[sim]   /name <sender>     Change simulated sender name');
        printAndPrompt('[sim]   /exit              Graceful shutdown');
        printAndPrompt('[sim] Type any other text to send a message.');
      };

      const startConsole = Effect.sync(() => {
        if (started) return;
        started = true;

        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: 'you> ',
        });

        printAndPrompt('[sim] Telegram simulation mode enabled');
        printAndPrompt(
          `[sim] Owner chat: ${normalizeChatJid(config.telegramOwnerId || '1')}`,
        );
        printHelp();

        rl.on('line', (line) => {
          const raw = line.trim();
          if (!raw) {
            rl?.prompt();
            return;
          }

          if (raw === '/help') {
            printHelp();
            return;
          }

          if (raw === '/exit') {
            process.kill(process.pid, 'SIGINT');
            return;
          }

          if (raw.startsWith('/chat ')) {
            const chatJid = normalizeChatJid(raw.slice('/chat '.length));
            Effect.runFork(
              Ref.set(currentChatRef, chatJid).pipe(
                Effect.tap(() => Effect.sync(() => printAndPrompt(`[sim] Active chat: ${chatJid}`))),
              ),
            );
            return;
          }

          if (raw.startsWith('/name ')) {
            const senderName = raw.slice('/name '.length).trim();
            if (!senderName) {
              printAndPrompt('[sim] Sender name cannot be empty');
              return;
            }
            Effect.runFork(
              Ref.set(currentSenderNameRef, senderName).pipe(
                Effect.tap(() => Effect.sync(() => printAndPrompt(`[sim] Sender: ${senderName}`))),
              ),
            );
            return;
          }

          Effect.runFork(
            Effect.gen(function* () {
              const chatJid = yield* Ref.get(currentChatRef);
              const senderName = yield* Ref.get(currentSenderNameRef);
              const seq = yield* Ref.getAndUpdate(nextIncomingIdRef, (n) => n + 1);

              yield* Queue.offer(incoming, {
                id: `sim-in-${seq}`,
                chatJid,
                sender: 'local-user',
                senderName,
                content: raw,
                timestamp: new Date().toISOString(),
              });

              yield* Effect.sync(() => printAndPrompt(`[sim->${chatJid}] ${raw}`));
            }),
          );
        });

        rl.prompt();
      });

      const printOutgoing = (prefix: string, chatJid: string, text: string) =>
        Effect.sync(() => {
          process.stdout.write(`\n[${prefix}:${chatJid}] ${text}\n`);
          rl?.prompt();
        });

      const service: TelegramService = {
        connect: startConsole.pipe(Effect.as(Stream.fromQueue(incoming))),

        sendMessage: (chatJid, text) =>
          printOutgoing('assistant', chatJid, text),

        sendMessageWithId: (chatJid, text) =>
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(nextOutgoingIdRef, (n) => n + 1);
            yield* printOutgoing('assistant', chatJid, text);
            return id;
          }),

        editMessageText: (chatJid, messageId, text) =>
          printOutgoing(
            'assistant-edit',
            chatJid,
            `#${messageId} ${text}`,
          ).pipe(Effect.as(true)),

        deleteMessage: (chatJid, messageId) =>
          printOutgoing('assistant-delete', chatJid, `#${messageId}`),

        sendPhoto: (chatJid, filePath, caption) =>
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(nextOutgoingIdRef, (n) => n + 1);
            const text = caption
              ? `${caption} (${filePath})`
              : `photo: ${filePath}`;
            yield* printOutgoing('assistant-photo', chatJid, text);
            return id;
          }),

        editPhoto: (chatJid, messageId, filePath, caption) => {
          const text = caption
            ? `#${messageId} ${caption} (${filePath})`
            : `#${messageId} ${filePath}`;
          return printOutgoing('assistant-photo-edit', chatJid, text).pipe(
            Effect.as(true),
          );
        },

        sendDocument: (chatJid, filePath, caption) => {
          const text = caption
            ? `${caption} (${filePath})`
            : `document: ${filePath}`;
          return printOutgoing('assistant-doc', chatJid, text);
        },

        sendVoice: (chatJid, filePath) =>
          printOutgoing('assistant-voice', chatJid, filePath),

        sendStatusMessage: (chatJid, text) =>
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(nextOutgoingIdRef, (n) => n + 1);
            yield* printOutgoing('status', chatJid, `#${id} ${text}`);
            return id;
          }),

        editStatusMessage: (chatJid, messageId, text) =>
          printOutgoing(
            'status-edit',
            chatJid,
            `#${messageId} ${text}`,
          ).pipe(Effect.as(true)),

        setTyping: (chatJid) => printOutgoing('typing', chatJid, '...'),

        stop: Effect.sync(() => {
          if (rl) {
            rl.close();
            rl = null;
          }
        }),
      };

      yield* Effect.addFinalizer(() =>
        Effect.all([service.stop, Queue.shutdown(incoming)]).pipe(Effect.ignore),
      );

      return service;
    }),
  );
