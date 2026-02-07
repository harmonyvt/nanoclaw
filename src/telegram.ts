import fs from 'fs';
import path from 'path';
import { Bot, InputFile } from 'grammy';

import {
  GROUPS_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  makeTelegramChatId,
  extractTelegramChatId,
} from './config.js';

import {
  clearMessages,
  getMessageCount,
  storeChatMetadata,
  storeMediaMessage,
  storeTextMessage,
} from './db.js';
import { downloadTelegramFile, transcribeAudio } from './media.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/**
 * Interface for managing sessions from telegram command handlers.
 * Passed in by the host (index.ts) so telegram.ts doesn't need direct access to session state.
 */
export interface SessionManager {
  /** Get the current sessionId for a chat's group folder, or undefined if none. */
  getSession(chatJid: string): string | undefined;
  /** Clear (delete) the sessionId for a chat's group folder so the next message starts fresh. */
  clearSession(chatJid: string): void;
}

// Read version from package.json at startup
const pkgPath = path.resolve(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
const APP_VERSION: string = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;

let bot: Bot | undefined;

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Extract common message metadata from a Telegram context.
 */
function extractMeta(ctx: {
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; last_name?: string };
  message?: { date: number; message_id: number };
}) {
  const chatId = makeTelegramChatId(ctx.chat.id);
  const timestamp = new Date(ctx.message!.date * 1000).toISOString();
  const sender = ctx.from!.id.toString();
  const senderName =
    ctx.from!.first_name +
    (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : '');
  const msgId = ctx.message!.message_id.toString();
  return { chatId, timestamp, sender, senderName, msgId };
}

/**
 * Check if a message should be accepted (private chat from owner).
 */
function shouldAccept(ctx: {
  chat: { type: string };
  from?: { id: number };
}): boolean {
  if (ctx.chat.type !== 'private') return false;
  if (TELEGRAM_OWNER_ID && ctx.from?.id.toString() !== TELEGRAM_OWNER_ID)
    return false;
  return true;
}

/**
 * Get the media directory for a registered group.
 */
function getMediaDir(group: RegisteredGroup): string {
  return path.join(GROUPS_DIR, group.folder, 'media');
}

/**
 * Connect to Telegram via long-polling.
 * Auto-registers the owner's private chat on first message.
 * Stores incoming messages into the DB.
 */
// Track process start time for uptime reporting
const startTime = Date.now();

export async function connectTelegram(
  registeredGroups: () => Record<string, RegisteredGroup>,
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void,
  sessionManager?: SessionManager,
): Promise<void> {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Register slash commands with Telegram immediately so they appear in the command menu.
  // This runs before bot.start() since bot.api only needs the token, not full initialization.
  try {
    await bot.api.setMyCommands([
      { command: 'new', description: 'Start a new conversation thread' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'status', description: 'Show session info' },
      { command: 'help', description: 'List commands' },
    ]);
    // Also set commands specifically for private chats so they appear in the / menu
    await bot.api.setMyCommands(
      [
        { command: 'new', description: 'Start a new conversation thread' },
        { command: 'clear', description: 'Clear conversation history' },
        { command: 'status', description: 'Show session info' },
        { command: 'help', description: 'List commands' },
      ],
      { scope: { type: 'all_private_chats' } },
    );
    logger.info('Bot commands registered with Telegram');
  } catch (err) {
    logger.error({ err }, 'Failed to register bot commands');
  }

  /**
   * Ensure the owner's chat is registered. Auto-registers as "main" on first contact.
   */
  function ensureRegistered(chatId: string, senderName: string): RegisteredGroup | null {
    const group = registeredGroups()[chatId];
    if (group) return group;

    // Auto-register owner's private chat as main
    if (onRegisterGroup) {
      const newGroup: RegisteredGroup = {
        name: senderName,
        folder: 'main',
        trigger: 'always',
        added_at: new Date().toISOString(),
      };
      onRegisterGroup(chatId, newGroup);
      logger.info({ chatId, name: senderName }, 'Auto-registered owner chat');
      return newGroup;
    }
    return null;
  }

  // --- Slash command handlers ---

  bot.command('new', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    if (sessionManager) {
      sessionManager.clearSession(chatId);
    }
    logger.info({ chatId }, 'Session reset via /new command');
    await ctx.reply('New thread started.');
  });

  bot.command('clear', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const deleted = clearMessages(chatId);
    if (sessionManager) {
      sessionManager.clearSession(chatId);
    }
    logger.info({ chatId, deleted }, 'History cleared via /clear command');
    await ctx.reply(`Cleared ${deleted} message${deleted === 1 ? '' : 's'} and reset session.`);
  });

  bot.command('status', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];

    const sessionId = sessionManager ? sessionManager.getSession(chatId) : undefined;
    const messageCount = getMessageCount(chatId);
    const uptimeMs = Date.now() - startTime;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

    const lines = [
      `Session: ${sessionId ? 'active' : 'none'}`,
      `Group: ${group ? group.name : 'unregistered'}`,
      `Messages: ${messageCount}`,
      `Uptime: ${uptimeHours}h ${uptimeMinutes}m`,
      `Version: v${APP_VERSION}`,
    ];
    if (sessionId) {
      lines.push(`Thread: ${sessionId.slice(0, 8)}`);
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('help', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const lines = [
      '/new - Start a new conversation thread',
      '/clear - Clear conversation history and reset session',
      '/status - Show session info, message count, uptime',
      '/help - List available commands',
    ];
    await ctx.reply(lines.join('\n'));
  });

  // --- Message handlers ---

  bot.on('message:text', (ctx) => {
    if (!shouldAccept(ctx)) return;

    const { chatId, timestamp, sender, senderName, msgId } = extractMeta(ctx);
    const content = ctx.message.text;

    storeChatMetadata(chatId, timestamp, senderName);

    if (ensureRegistered(chatId, senderName)) {
      storeTextMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false,
      );
    }
  });

  // Voice message handler
  bot.on('message:voice', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    const { chatId, timestamp, sender, senderName, msgId } = extractMeta(ctx);
    storeChatMetadata(chatId, timestamp, senderName);
    const group = ensureRegistered(chatId, senderName);
    if (!group) return;

    const voice = ctx.message.voice;
    if (voice.file_size && voice.file_size > 20 * 1024 * 1024) {
      logger.warn(
        { msgId, size: voice.file_size },
        'Voice message too large, skipping',
      );
      return;
    }

    try {
      const mediaDir = getMediaDir(group);
      const localPath = await downloadTelegramFile(
        bot!,
        voice.file_id,
        mediaDir,
      );
      if (!localPath) return;

      const transcription = await transcribeAudio(localPath);
      const content = `[Voice message: ${transcription}]`;

      storeMediaMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false,
        'voice',
        localPath,
      );
    } catch (err) {
      logger.error({ msgId, err }, 'Error processing voice message');
    }
  });

  // Audio message handler (music files sent as audio)
  bot.on('message:audio', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    const { chatId, timestamp, sender, senderName, msgId } = extractMeta(ctx);
    storeChatMetadata(chatId, timestamp, senderName);
    const group = ensureRegistered(chatId, senderName);
    if (!group) return;

    const audio = ctx.message.audio;
    if (audio.file_size && audio.file_size > 20 * 1024 * 1024) {
      logger.warn(
        { msgId, size: audio.file_size },
        'Audio file too large, skipping',
      );
      return;
    }

    try {
      const mediaDir = getMediaDir(group);
      const localPath = await downloadTelegramFile(
        bot!,
        audio.file_id,
        mediaDir,
      );
      if (!localPath) return;

      const transcription = await transcribeAudio(localPath);
      const content = `[Audio message: ${transcription}]`;

      storeMediaMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false,
        'audio',
        localPath,
      );
    } catch (err) {
      logger.error({ msgId, err }, 'Error processing audio message');
    }
  });

  // Photo handler
  bot.on('message:photo', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    const { chatId, timestamp, sender, senderName, msgId } = extractMeta(ctx);
    storeChatMetadata(chatId, timestamp, senderName);
    const group = ensureRegistered(chatId, senderName);
    if (!group) return;

    // Get highest resolution photo (last in array)
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (photo.file_size && photo.file_size > 20 * 1024 * 1024) {
      logger.warn(
        { msgId, size: photo.file_size },
        'Photo too large, skipping',
      );
      return;
    }

    try {
      const mediaDir = getMediaDir(group);
      const localPath = await downloadTelegramFile(
        bot!,
        photo.file_id,
        mediaDir,
      );
      if (!localPath) return;

      const content = ctx.message.caption || '[Photo]';

      storeMediaMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false,
        'photo',
        localPath,
      );
    } catch (err) {
      logger.error({ msgId, err }, 'Error processing photo message');
    }
  });

  // Document handler
  bot.on('message:document', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    const { chatId, timestamp, sender, senderName, msgId } = extractMeta(ctx);
    storeChatMetadata(chatId, timestamp, senderName);
    const group = ensureRegistered(chatId, senderName);
    if (!group) return;

    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      logger.warn(
        { msgId, size: doc.file_size },
        'Document too large, skipping',
      );
      return;
    }

    try {
      const mediaDir = getMediaDir(group);
      const localPath = await downloadTelegramFile(bot!, doc.file_id, mediaDir);
      if (!localPath) return;

      const content = ctx.message.caption || doc.file_name || '[Document]';

      storeMediaMessage(
        msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        false,
        'document',
        localPath,
      );
    } catch (err) {
      logger.error({ msgId, err }, 'Error processing document message');
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  bot.start({
    onStart: async () => {
      logger.info('Connected to Telegram');

      if (TELEGRAM_OWNER_ID) {
        try {
          const ownerChatId = makeTelegramChatId(Number(TELEGRAM_OWNER_ID));
          await sendTelegramMessage(ownerChatId, `Online v${APP_VERSION}`);
        } catch (err) {
          logger.error({ err }, 'Failed to send startup message to owner');
        }
      }
    },
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
 * Send a photo to a Telegram chat from a local file path.
 */
export async function sendTelegramPhoto(
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!bot) {
    logger.error('Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);
  await bot.api.sendPhoto(numericId, new InputFile(filePath), {
    caption,
  });
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
