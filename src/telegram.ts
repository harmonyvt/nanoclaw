import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
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
const PROJECT_ROOT = path.resolve(
  import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname),
  '..',
);
const pkgPath = path.join(PROJECT_ROOT, 'package.json');
const APP_VERSION: string = JSON.parse(
  fs.readFileSync(pkgPath, 'utf-8'),
).version;
const SELF_UPDATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'self-update.sh');
const SELF_UPDATE_LOG = path.join(PROJECT_ROOT, 'logs', 'self-update.log');
const SELF_UPDATE_CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const SELF_UPDATE_ENABLED = process.env.SELF_UPDATE_ENABLED !== 'false';
const SELF_UPDATE_BRANCH = process.env.SELF_UPDATE_BRANCH || 'main';
const SELF_UPDATE_REMOTE = process.env.SELF_UPDATE_REMOTE || 'origin';
const execFileAsync = promisify(execFile);

type PendingUpdate = {
  behind: number;
  localHead: string;
  remoteHead: string;
  expiresAt: number;
};
const pendingUpdatesByChat = new Map<string, PendingUpdate>();

let bot: Bot | undefined;

const verboseChats = new Set<string>();
export function isVerbose(chatJid: string): boolean {
  return verboseChats.has(chatJid);
}

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

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: PROJECT_ROOT });
  return stdout.trim();
}

async function checkForServiceUpdate(): Promise<{
  behind: number;
  localHead: string;
  remoteHead: string;
}> {
  await runGit(['fetch', '--quiet', SELF_UPDATE_REMOTE, SELF_UPDATE_BRANCH]);
  const remoteRef = `${SELF_UPDATE_REMOTE}/${SELF_UPDATE_BRANCH}`;
  const [localHead, remoteHead, behindRaw] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['rev-parse', remoteRef]),
    runGit(['rev-list', '--count', `HEAD..${remoteRef}`]),
  ]);
  const behind = Number.parseInt(behindRaw, 10);
  if (Number.isNaN(behind)) {
    throw new Error(`Unexpected git rev-list output: ${behindRaw}`);
  }
  return { behind, localHead, remoteHead };
}

function startSelfUpdateProcess(): void {
  if (!fs.existsSync(SELF_UPDATE_SCRIPT)) {
    throw new Error(`Self-update script is missing: ${SELF_UPDATE_SCRIPT}`);
  }

  fs.mkdirSync(path.dirname(SELF_UPDATE_LOG), { recursive: true });
  fs.appendFileSync(
    SELF_UPDATE_LOG,
    `[${new Date().toISOString()}] Triggered update from Telegram\n`,
  );

  const outputFd = fs.openSync(SELF_UPDATE_LOG, 'a');
  const child = spawn('bash', [SELF_UPDATE_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', outputFd, outputFd],
    env: {
      ...process.env,
      SELF_UPDATE_BRANCH,
      SELF_UPDATE_REMOTE,
    },
  });
  child.unref();
  fs.closeSync(outputFd);
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
  const commandList = [
    { command: 'new', description: 'Start a new conversation thread' },
    { command: 'clear', description: 'Clear conversation history' },
    { command: 'status', description: 'Show session info' },
    { command: 'update', description: 'Check and apply service update' },
    {
      command: 'verbose',
      description: 'Toggle verbose mode (show agent tool use)',
    },
    { command: 'help', description: 'List commands' },
  ] as const;

  // Register slash commands with Telegram immediately so they appear in the command menu.
  // This runs before bot.start() since bot.api only needs the token, not full initialization.
  try {
    await bot.api.setMyCommands(commandList);
    // Also set commands specifically for private chats so they appear in the / menu
    await bot.api.setMyCommands(commandList, {
      scope: { type: 'all_private_chats' },
    });
    logger.info('Bot commands registered with Telegram');
  } catch (err) {
    logger.error({ err }, 'Failed to register bot commands');
  }

  /**
   * Ensure the owner's chat is registered. Auto-registers as "main" on first contact.
   */
  function ensureRegistered(
    chatId: string,
    senderName: string,
  ): RegisteredGroup | null {
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
    await ctx.reply(
      `Cleared ${deleted} message${deleted === 1 ? '' : 's'} and reset session.`,
    );
  });

  bot.command('status', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];

    const sessionId = sessionManager
      ? sessionManager.getSession(chatId)
      : undefined;
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
      '/update - Check for updates and request confirmation',
      '/update confirm - Apply latest update',
      '/update cancel - Cancel pending update',
      '/verbose - Toggle verbose mode (show agent tool use)',
      '/help - List available commands',
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('verbose', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    if (verboseChats.has(chatId)) {
      verboseChats.delete(chatId);
      await ctx.reply('Verbose mode off');
    } else {
      verboseChats.add(chatId);
      await ctx.reply('Verbose mode on');
    }
  });

  bot.command('update', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    if (!SELF_UPDATE_ENABLED) {
      await ctx.reply('Self-update is disabled (SELF_UPDATE_ENABLED=false).');
      return;
    }

    const chatId = makeTelegramChatId(ctx.chat.id);
    const action = ctx.match.trim().toLowerCase();

    if (action === 'confirm') {
      const pending = pendingUpdatesByChat.get(chatId);
      if (!pending) {
        await ctx.reply('No pending update confirmation. Run /update first.');
        return;
      }
      if (Date.now() > pending.expiresAt) {
        pendingUpdatesByChat.delete(chatId);
        await ctx.reply('Update confirmation expired. Run /update again.');
        return;
      }

      pendingUpdatesByChat.delete(chatId);
      await ctx.reply(
        `Starting update now. I will pull latest code, rebuild, and restart the service.\nIf anything fails, check ${SELF_UPDATE_LOG}.`,
      );

      try {
        startSelfUpdateProcess();
      } catch (err) {
        logger.error({ err }, 'Failed to start self-update process');
        await ctx.reply('Failed to start update. Check logs and try again.');
      }
      return;
    }

    if (action === 'cancel') {
      const hadPending = pendingUpdatesByChat.delete(chatId);
      await ctx.reply(
        hadPending
          ? 'Pending update canceled.'
          : 'No pending update to cancel.',
      );
      return;
    }

    if (action.length > 0) {
      await ctx.reply(
        'Unknown option. Use /update, /update confirm, or /update cancel.',
      );
      return;
    }

    try {
      const { behind, localHead, remoteHead } = await checkForServiceUpdate();
      if (behind <= 0) {
        pendingUpdatesByChat.delete(chatId);
        await ctx.reply(
          `Already up to date on ${SELF_UPDATE_REMOTE}/${SELF_UPDATE_BRANCH}.`,
        );
        return;
      }

      pendingUpdatesByChat.set(chatId, {
        behind,
        localHead,
        remoteHead,
        expiresAt: Date.now() + SELF_UPDATE_CONFIRM_WINDOW_MS,
      });

      const lines = [
        `Update available on ${SELF_UPDATE_REMOTE}/${SELF_UPDATE_BRANCH}.`,
        `Behind by ${behind} commit${behind === 1 ? '' : 's'}.`,
        `Current: ${localHead.slice(0, 8)}`,
        `Latest: ${remoteHead.slice(0, 8)}`,
        'Reply /update confirm within 5 minutes to apply it.',
      ];
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      logger.error({ err }, 'Failed to check for updates');
      await ctx.reply(
        'Could not check for updates. Verify git remote access and try again.',
      );
    }
  });

  // --- Message handlers ---

  bot.on('message:text', (ctx) => {
    if (!shouldAccept(ctx)) return;
    const firstEntity = ctx.message.entities?.[0];
    const isSlashCommand =
      firstEntity?.type === 'bot_command' && firstEntity.offset === 0;
    if (isSlashCommand) return;

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
