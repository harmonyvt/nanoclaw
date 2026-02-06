import fs from 'fs';
import path from 'path';

import { Bot, Context } from 'grammy';

import {
  GROUPS_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_FILE_MAX_SIZE,
  TELEGRAM_OWNER_ID,
  UPLOADS_DIR_NAME,
  makeTelegramChatId,
  extractTelegramChatId,
} from './config.js';
import { storeChatMetadata, storeTextMessage } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

let bot: Bot | undefined;

const TELEGRAM_MAX_LENGTH = 4096;

type FileType =
  | 'photo'
  | 'document'
  | 'video'
  | 'voice'
  | 'video_note'
  | 'audio'
  | 'sticker';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function extFromName(fileName?: string, mimeType?: string): string {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext;
  }
  return mimeType ? (MIME_EXT[mimeType] || '') : '';
}

async function downloadFile(
  fileId: string,
  destPath: string,
): Promise<boolean> {
  if (!bot) return false;
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'Telegram getFile returned no file_path');
      return false;
    }
    if (file.file_size && file.file_size > TELEGRAM_FILE_MAX_SIZE) {
      logger.warn(
        { fileId, size: file.file_size },
        'File exceeds max size, skipping',
      );
      return false;
    }
    const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.error({ fileId, status: res.status }, 'Failed to download file');
      return false;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch (err) {
    logger.error({ fileId, err }, 'Error downloading Telegram file');
    return false;
  }
}

function handleFileMessage(
  ctx: Context,
  registeredGroups: () => Record<string, RegisteredGroup>,
  fileType: FileType,
): void {
  if (!ctx.chat || ctx.chat.type !== 'private') return;
  if (!ctx.from) return;
  if (TELEGRAM_OWNER_ID && ctx.from.id.toString() !== TELEGRAM_OWNER_ID)
    return;

  const chatId = makeTelegramChatId(ctx.chat.id);
  const timestamp = new Date((ctx.message?.date ?? 0) * 1000).toISOString();
  const sender = ctx.from.id.toString();
  const senderName =
    ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
  const msgId = ctx.message!.message_id.toString();
  const caption = ctx.message?.caption || '';

  storeChatMetadata(chatId, timestamp, senderName);

  const group = registeredGroups()[chatId];
  if (!group) return;

  // Extract file_id and description per type
  let fileId: string;
  let fileName: string | undefined;
  let mimeType: string | undefined;
  let desc: string;

  const msg = ctx.message!;

  switch (fileType) {
    case 'photo': {
      const photos = msg.photo!;
      const largest = photos[photos.length - 1];
      fileId = largest.file_id;
      mimeType = 'image/jpeg';
      desc = `photo (${largest.width}x${largest.height})`;
      break;
    }
    case 'document': {
      const doc = msg.document!;
      fileId = doc.file_id;
      fileName = doc.file_name;
      mimeType = doc.mime_type;
      desc = `document: ${doc.file_name || 'unknown'}${doc.mime_type ? ` (${doc.mime_type})` : ''}`;
      break;
    }
    case 'video': {
      const v = msg.video!;
      fileId = v.file_id;
      fileName = v.file_name;
      mimeType = v.mime_type || 'video/mp4';
      desc = `video (${v.width}x${v.height}, ${v.duration}s)`;
      break;
    }
    case 'voice': {
      const voice = msg.voice!;
      fileId = voice.file_id;
      mimeType = voice.mime_type || 'audio/ogg';
      desc = `voice message (${voice.duration}s)`;
      break;
    }
    case 'video_note': {
      const vn = msg.video_note!;
      fileId = vn.file_id;
      mimeType = 'video/mp4';
      desc = `video note (${vn.duration}s)`;
      break;
    }
    case 'audio': {
      const a = msg.audio!;
      fileId = a.file_id;
      fileName = a.file_name;
      mimeType = a.mime_type;
      desc = `audio: ${a.title || a.file_name || 'unknown'} (${a.duration}s)`;
      break;
    }
    case 'sticker': {
      const s = msg.sticker!;
      fileId = s.file_id;
      mimeType = s.is_animated
        ? 'application/x-tgs'
        : s.is_video
          ? 'video/webm'
          : 'image/webp';
      desc = `sticker${s.emoji ? ` ${s.emoji}` : ''}`;
      break;
    }
  }

  const ext = extFromName(fileName, mimeType);
  const safeName = fileName
    ? fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    : fileType;
  const destFilename = `${Date.now()}-${safeName}${fileName ? '' : ext}`;
  const uploadsDir = path.join(GROUPS_DIR, group.folder, UPLOADS_DIR_NAME);
  const destPath = path.join(uploadsDir, destFilename);
  const containerPath = `/workspace/group/${UPLOADS_DIR_NAME}/${destFilename}`;

  // Download async, then store message
  downloadFile(fileId, destPath).then((ok) => {
    if (!ok) {
      const content = caption
        ? `${caption}\n\n[Failed to download ${desc}]`
        : `[Failed to download ${desc}]`;
      storeTextMessage(msgId, chatId, sender, senderName, content, timestamp, false);
      return;
    }

    // Build hint for the agent
    const readable =
      fileType === 'photo' ||
      fileType === 'sticker' ||
      mimeType === 'application/pdf' ||
      mimeType?.startsWith('image/');
    let hint: string;
    if (readable) {
      hint = '[Use the Read tool to view this file]';
    } else if (fileType === 'voice' || fileType === 'audio') {
      hint = '[Audio file — use Bash to process if needed]';
    } else {
      hint = '[Video file — use Bash with ffmpeg to extract frames if needed]';
    }

    const content = caption
      ? `${caption}\n\n[Attached ${desc} — ${containerPath}]\n${hint}`
      : `[Sent ${desc} — ${containerPath}]\n${hint}`;

    storeTextMessage(msgId, chatId, sender, senderName, content, timestamp, false);
    logger.info({ chatId, fileType, destFilename }, 'File saved');
  });
}

/**
 * Connect to Telegram via long-polling.
 * Stores incoming text messages into the DB.
 */
export function connectTelegram(
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

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

  // File message handlers
  bot.on('message:photo', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'photo'));
  bot.on('message:document', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'document'));
  bot.on('message:video', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'video'));
  bot.on('message:voice', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'voice'));
  bot.on('message:video_note', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'video_note'));
  bot.on('message:audio', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'audio'));
  bot.on('message:sticker', (ctx) =>
    handleFileMessage(ctx, registeredGroups, 'sticker'));

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

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
