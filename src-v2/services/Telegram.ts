/**
 * Telegram service — wraps grammY bot as an Effect Service.
 * Exposes incoming messages as an Effect Stream.
 */

import { Context, Effect, Stream } from 'effect';
import type { TelegramError, TelegramSendError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface IncomingMessage {
  readonly id: string;
  readonly chatJid: string;
  readonly sender: string;
  readonly senderName: string;
  readonly content: string;
  readonly timestamp: string;
  readonly mediaType?: string;
  readonly mediaPath?: string;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface TelegramService {
  /** Connect the bot and return a stream of incoming messages */
  readonly connect: Effect.Effect<
    Stream.Stream<IncomingMessage, TelegramError>,
    TelegramError
  >;

  readonly sendMessage: (
    chatJid: string,
    text: string,
  ) => Effect.Effect<void, TelegramSendError>;

  readonly sendMessageWithId: (
    chatJid: string,
    text: string,
  ) => Effect.Effect<number | null, TelegramSendError>;

  readonly editMessageText: (
    chatJid: string,
    messageId: number,
    text: string,
  ) => Effect.Effect<boolean, TelegramSendError>;

  readonly deleteMessage: (
    chatJid: string,
    messageId: number,
  ) => Effect.Effect<void, TelegramSendError>;

  readonly sendPhoto: (
    chatJid: string,
    path: string,
    caption?: string,
  ) => Effect.Effect<number | null, TelegramSendError>;

  readonly editPhoto: (
    chatJid: string,
    messageId: number,
    path: string,
    caption?: string,
  ) => Effect.Effect<boolean, TelegramSendError>;

  readonly sendDocument: (
    chatJid: string,
    path: string,
    caption?: string,
  ) => Effect.Effect<void, TelegramSendError>;

  readonly sendVoice: (
    chatJid: string,
    path: string,
  ) => Effect.Effect<void, TelegramSendError>;

  readonly sendStatusMessage: (
    chatJid: string,
    text: string,
  ) => Effect.Effect<number | null, TelegramSendError>;

  readonly editStatusMessage: (
    chatJid: string,
    messageId: number,
    text: string,
  ) => Effect.Effect<boolean, TelegramSendError>;

  readonly setTyping: (
    chatJid: string,
  ) => Effect.Effect<void, TelegramSendError>;

  readonly stop: Effect.Effect<void, TelegramError>;
}

export class Telegram extends Context.Tag('Telegram')<
  Telegram,
  TelegramService
>() {}
