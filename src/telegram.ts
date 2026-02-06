import { Bot } from 'grammy';

import { getAll } from './commands.js';
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  makeTelegramChatId,
  extractTelegramChatId,
} from './config.js';
import { storeChatMetadata, storeTextMessage } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup, Session } from './types.js';

let bot: Bot | undefined;

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Connect to Telegram via long-polling.
 * Registers command handlers, then stores incoming text messages into the DB.
 */
export function connectTelegram(
  registeredGroups: () => Record<string, RegisteredGroup>,
  commandDeps: { sessions: () => Session },
): void {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Register command handlers BEFORE the general text handler.
  // grammY middleware runs in registration order, so commands are
  // intercepted before reaching bot.on('message:text').
  for (const cmd of getAll()) {
    bot.command(cmd.name, async (gramCtx) => {
      if (gramCtx.chat.type !== 'private') return;
      const from = gramCtx.from;
      if (!from) return;
      if (TELEGRAM_OWNER_ID && from.id.toString() !== TELEGRAM_OWNER_ID)
        return;

      const chatId = makeTelegramChatId(gramCtx.chat.id);

      if (cmd.type === 'host') {
        const result = await cmd.handler({
          chatId,
          args: gramCtx.match?.toString() || '',
          registeredGroups: registeredGroups(),
          sessions: commandDeps.sessions(),
        });
        if (result) {
          await gramCtx.reply(result);
        }
      } else {
        // Agent command: store as regular message for the polling loop
        const msgId = gramCtx.message?.message_id.toString() || Date.now().toString();
        const timestamp = new Date((gramCtx.message?.date || Date.now() / 1000) * 1000).toISOString();
        const sender = from.id.toString();
        const senderName =
          from.first_name + (from.last_name ? ` ${from.last_name}` : '');

        storeChatMetadata(chatId, timestamp, senderName);

        if (registeredGroups()[chatId]) {
          storeTextMessage(
            msgId,
            chatId,
            sender,
            senderName,
            gramCtx.message?.text || '',
            timestamp,
            false,
          );
        }
      }
    });
  }

  bot.on('message:text', (ctx) => {
    // Only accept DMs (private chats)
    if (ctx.chat.type !== 'private') return;

    // Only accept messages from the authorized owner
    if (TELEGRAM_OWNER_ID && ctx.from.id.toString() !== TELEGRAM_OWNER_ID)
      return;

    const chatId = makeTelegramChatId(ctx.chat.id);
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const sender = ctx.from.id.toString();
    const senderName =
      ctx.from.first_name +
      (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    const msgId = ctx.message.message_id.toString();
    const content = ctx.message.text;

    const chatName = senderName;

    storeChatMetadata(chatId, timestamp, chatName);

    // Only store full message content for registered chats
    if (registeredGroups()[chatId]) {
      storeTextMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false, // messages from Telegram users are never "from me"
      );
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  // Set Telegram's command menu for autocomplete
  bot.api
    .setMyCommands(
      getAll().map((cmd) => ({
        command: cmd.name,
        description: cmd.description,
      })),
    )
    .catch((err) => logger.warn({ err }, 'Failed to set bot commands menu'));

  bot.start({
    onStart: () => logger.info('Connected to Telegram'),
  });
}

/**
 * Send a text message to a Telegram chat.
 * Splits messages that exceed Telegram's 4096-character limit.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!bot) {
    logger.error('Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);

  // Split into chunks if needed
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) splitAt = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    await bot.api.sendMessage(numericId, chunk);
  }
}

/**
 * Send a typing indicator (chat action) to a Telegram chat.
 */
export async function setTelegramTyping(chatId: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.sendChatAction(extractTelegramChatId(chatId), 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to send Telegram typing action');
  }
}

/**
 * Gracefully stop the Telegram bot.
 */
export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    logger.info('Telegram bot stopped');
  }
}
