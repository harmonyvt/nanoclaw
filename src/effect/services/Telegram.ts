/**
 * Effect service: Telegram
 *
 * Wraps grammY bot operations into an Effect service with
 * proper resource management (start/stop lifecycle).
 */
import { Context, Effect, Layer } from 'effect';
import type { RunnerHandle } from '@grammyjs/runner';

import {
  connectTelegram,
  sendTelegramMessage,
  sendTelegramDocument,
  sendTelegramPhoto,
  editTelegramPhoto,
  sendTelegramMessageWithId,
  editTelegramMessageText,
  sendTelegramStatusMessage,
  editTelegramStatusMessage,
  deleteTelegramMessage,
  sendTelegramVoice,
  setTelegramTyping,
  stopTelegram,
  isVerbose,
  isThinkingEnabled,
  addThinkingDisabled,
  removeThinkingDisabled,
} from '../../telegram.js';
import type { OnMessageStored, TaskActionHandler, InterruptHandler } from '../../telegram.js';
import type { RegisteredGroup } from '../../types.js';

export interface TelegramService {
  readonly connect: (
    getGroups: () => Record<string, RegisteredGroup>,
    registerGroup: (jid: string, group: RegisteredGroup) => void,
    taskActions: TaskActionHandler,
    interruptHandler: InterruptHandler,
    onMessageStored: OnMessageStored,
  ) => Effect.Effect<RunnerHandle>;
  readonly stop: () => Effect.Effect<void>;
  readonly sendMessage: (jid: string, text: string) => Effect.Effect<void>;
  readonly sendDocument: (jid: string, filePath: string, caption?: string) => Effect.Effect<void>;
  readonly sendPhoto: (jid: string, photoPath: string, caption?: string) => Effect.Effect<number | null>;
  readonly editPhoto: (jid: string, messageId: number, photoPath: string, caption?: string) => Effect.Effect<boolean>;
  readonly sendMessageWithId: (jid: string, text: string) => Effect.Effect<number | null>;
  readonly editMessageText: (jid: string, messageId: number, text: string) => Effect.Effect<boolean>;
  readonly sendStatusMessage: (jid: string, text: string) => Effect.Effect<number | null>;
  readonly editStatusMessage: (jid: string, messageId: number, text: string) => Effect.Effect<boolean>;
  readonly deleteMessage: (jid: string, messageId: number) => Effect.Effect<void>;
  readonly sendVoice: (jid: string, oggPath: string) => Effect.Effect<void>;
  readonly setTyping: (jid: string) => Effect.Effect<void>;
  readonly isVerbose: (chatJid: string) => boolean;
  readonly isThinkingEnabled: (chatJid: string) => boolean;
  readonly addThinkingDisabled: (chatJid: string) => void;
  readonly removeThinkingDisabled: (chatJid: string) => void;
}

export class Telegram extends Context.Tag('nanoclaw/Telegram')<
  Telegram,
  TelegramService
>() {}

export const TelegramLive = Layer.succeed(Telegram, {
  connect: (getGroups, registerGroup, taskActions, interruptHandler, onMessageStored) =>
    Effect.promise(() => connectTelegram(getGroups, registerGroup, taskActions, interruptHandler, onMessageStored)),
  stop: () =>
    Effect.promise(async () => {
      const stopPromise = stopTelegram();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
      await Promise.race([stopPromise, timeout]);
    }),
  sendMessage: (jid, text) => Effect.promise(() => sendTelegramMessage(jid, text)),
  sendDocument: (jid, filePath, caption) => Effect.promise(() => sendTelegramDocument(jid, filePath, caption)),
  sendPhoto: (jid, photoPath, caption) => Effect.promise(() => sendTelegramPhoto(jid, photoPath, caption)),
  editPhoto: (jid, messageId, photoPath, caption) =>
    Effect.promise(() => editTelegramPhoto(jid, messageId, photoPath, caption)),
  sendMessageWithId: (jid, text) => Effect.promise(() => sendTelegramMessageWithId(jid, text)),
  editMessageText: (jid, messageId, text) =>
    Effect.promise(() => editTelegramMessageText(jid, messageId, text)),
  sendStatusMessage: (jid, text) => Effect.promise(() => sendTelegramStatusMessage(jid, text)),
  editStatusMessage: (jid, messageId, text) =>
    Effect.promise(() => editTelegramStatusMessage(jid, messageId, text)),
  deleteMessage: (jid, messageId) => Effect.promise(() => deleteTelegramMessage(jid, messageId)),
  sendVoice: (jid, oggPath) => Effect.promise(() => sendTelegramVoice(jid, oggPath)),
  setTyping: (jid) => Effect.promise(() => setTelegramTyping(jid)),
  isVerbose,
  isThinkingEnabled,
  addThinkingDisabled,
  removeThinkingDisabled,
} satisfies TelegramService);
