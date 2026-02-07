import fs from 'fs';
import path from 'path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';

import {
  GROUPS_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  makeTelegramChatId,
  extractTelegramChatId,
} from './config.js';

import {
  clearMessages,
  getAllTasks,
  getMessageCount,
  getTaskById,
  getTaskByShortId,
  getTaskRunLogs,
  getTasksForGroup,
  updateTask,
  deleteTask,
  storeChatMetadata,
  storeMediaMessage,
  storeTextMessage,
} from './db.js';
import { downloadTelegramFile, transcribeAudio } from './media.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

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

/**
 * Interface for triggering task actions from telegram command handlers.
 * Passed in by the host (index.ts) so telegram.ts doesn't depend on task-scheduler.
 */
export interface TaskActionHandler {
  runTaskNow(taskId: string): Promise<{ success: boolean; error?: string; durationMs?: number }>;
}

// --- Task formatting helpers ---

function shortId(taskId: string): string {
  return taskId.slice(-8);
}

function resolveTask(idOrShort: string): ScheduledTask | undefined {
  return getTaskById(idOrShort) || getTaskByShortId(idOrShort);
}

function formatSchedule(task: ScheduledTask): string {
  if (task.schedule_type === 'cron') {
    return `cron: ${task.schedule_value}`;
  }
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (ms >= 86400000) return `every ${Math.round(ms / 86400000)}d`;
    if (ms >= 3600000) return `every ${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `every ${Math.round(ms / 60000)}m`;
    return `every ${Math.round(ms / 1000)}s`;
  }
  if (task.schedule_type === 'once') {
    return `once: ${task.schedule_value.replace('T', ' ').slice(0, 16)}`;
  }
  return task.schedule_type;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '--';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const suffix = diff > 0 ? '' : ' ago';
  const prefix = diff > 0 ? 'in ' : '';
  if (abs < 60000) return `${prefix}${Math.round(abs / 1000)}s${suffix}`;
  if (abs < 3600000) return `${prefix}${Math.round(abs / 60000)}m${suffix}`;
  if (abs < 86400000) return `${prefix}${Math.round(abs / 3600000)}h${suffix}`;
  return `${prefix}${Math.round(abs / 86400000)}d${suffix}`;
}

function truncatePrompt(prompt: string, max = 60): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return 'No tasks scheduled. Ask me to create one.';

  const active = tasks.filter(t => t.status === 'active').length;
  const paused = tasks.filter(t => t.status === 'paused').length;
  const completed = tasks.filter(t => t.status === 'completed').length;

  const parts = [];
  if (active) parts.push(`${active} active`);
  if (paused) parts.push(`${paused} paused`);
  if (completed) parts.push(`${completed} done`);

  const lines = [`<b>Tasks</b> (${parts.join(', ')})\n`];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const status = t.status === 'active' ? 'active' : t.status === 'paused' ? 'paused' : 'done';
    const nextInfo = t.next_run ? ` | next: ${formatRelativeTime(t.next_run)}` : '';
    lines.push(
      `${i + 1}. <b>${escapeHtml(truncatePrompt(t.prompt, 40))}</b>\n` +
      `   <code>${formatSchedule(t)}</code> | ${status}${nextInfo}`
    );
  }

  return lines.join('\n');
}

function buildTaskListKeyboard(tasks: ScheduledTask[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of tasks) {
    const sid = shortId(t.id);
    if (t.status === 'active') {
      kb.text('Pause', `t:pause:${sid}`);
    } else if (t.status === 'paused') {
      kb.text('Resume', `t:resume:${sid}`);
    }
    kb.text('Run Now', `t:run:${sid}`);
    kb.text('Details', `t:detail:${sid}`);
    kb.row();
  }
  return kb;
}

function formatTaskDetail(task: ScheduledTask): string {
  const lines = [
    `<b>Task Detail</b>\n`,
    `<b>ID:</b> <code>${escapeHtml(task.id)}</code>`,
    `<b>Prompt:</b> ${escapeHtml(truncatePrompt(task.prompt, 200))}`,
    `<b>Schedule:</b> ${escapeHtml(formatSchedule(task))}`,
    `<b>Context:</b> ${task.context_mode}`,
    `<b>Status:</b> ${task.status}`,
    `<b>Next run:</b> ${task.next_run ? formatRelativeTime(task.next_run) : '--'}`,
    `<b>Last run:</b> ${task.last_run ? formatRelativeTime(task.last_run) : 'never'}`,
  ];
  if (task.last_result) {
    lines.push(`<b>Last result:</b> ${escapeHtml(task.last_result.slice(0, 200))}`);
  }
  return lines.join('\n');
}

function buildTaskDetailKeyboard(task: ScheduledTask): InlineKeyboard {
  const sid = shortId(task.id);
  const kb = new InlineKeyboard();
  if (task.status === 'active') {
    kb.text('Pause', `t:pause:${sid}`);
  } else if (task.status === 'paused') {
    kb.text('Resume', `t:resume:${sid}`);
  }
  kb.text('Run Now', `t:run:${sid}`);
  kb.row();
  kb.text('Run Logs', `t:logs:${sid}`);
  kb.text('Delete', `t:del:${sid}`);
  kb.text('Back', `t:back:_`);
  return kb;
}

// Read version from package.json at startup
const pkgPath = path.resolve(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
const APP_VERSION: string = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;

let bot: Bot | undefined;

const verboseChats = new Set<string>();
export function isVerbose(chatJid: string): boolean { return verboseChats.has(chatJid); }

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
  taskActions?: TaskActionHandler,
): Promise<void> {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Register slash commands with Telegram immediately so they appear in the command menu.
  // This runs before bot.start() since bot.api only needs the token, not full initialization.
  try {
    const commandList = [
      { command: 'tasks', description: 'List scheduled tasks and automations' },
      { command: 'new', description: 'Start a new conversation thread' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'status', description: 'Show session info' },
      { command: 'verbose', description: 'Toggle verbose mode (show agent tool use)' },
      { command: 'help', description: 'List commands' },
    ];
    await bot.api.setMyCommands(commandList);
    await bot.api.setMyCommands(commandList, { scope: { type: 'all_private_chats' } });
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
      '/tasks - List scheduled tasks and automations',
      '/runtask &lt;id&gt; - Trigger a task immediately',
      '/new - Start a new conversation thread',
      '/clear - Clear conversation history and reset session',
      '/status - Show session info, message count, uptime',
      '/verbose - Toggle verbose mode (show agent tool use)',
      '/help - List available commands',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
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

  // --- Task commands ---

  bot.command('tasks', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    const isMain = group && group.folder === 'main';

    // Main sees all, others see only their group
    const tasks = isMain
      ? getAllTasks().filter(t => t.status !== 'completed')
      : group
        ? getTasksForGroup(group.folder).filter(t => t.status !== 'completed')
        : [];

    const text = formatTaskList(tasks);
    const kb = tasks.length > 0 ? buildTaskListKeyboard(tasks) : undefined;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...(kb ? { reply_markup: kb } : {}),
    });
  });

  bot.command('runtask', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const idArg = ctx.match?.trim();
    if (!idArg) {
      await ctx.reply('Usage: /runtask <task-id>');
      return;
    }

    const task = resolveTask(idArg);
    if (!task) {
      await ctx.reply('Task not found.');
      return;
    }

    if (!taskActions) {
      await ctx.reply('Task runner not available.');
      return;
    }

    await ctx.reply(`Running task: ${truncatePrompt(task.prompt, 60)}...`);
    const result = await taskActions.runTaskNow(task.id);
    if (result.success) {
      const dur = result.durationMs ? ` (${Math.round(result.durationMs / 1000)}s)` : '';
      await ctx.reply(`Task completed${dur}.`);
    } else {
      await ctx.reply(`Task failed: ${result.error || 'Unknown error'}`);
    }
  });

  // --- Inline keyboard callback handler ---

  bot.on('callback_query:data', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('t:')) return;

    const parts = data.split(':');
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid action' });
      return;
    }

    const action = parts[1];
    const sid = parts[2];
    const chatId = makeTelegramChatId(ctx.callbackQuery.from.id);
    const group = registeredGroups()[chatId];
    const isMain = group && group.folder === 'main';

    // "back" action returns to task list
    if (action === 'back') {
      const tasks = isMain
        ? getAllTasks().filter(t => t.status !== 'completed')
        : group
          ? getTasksForGroup(group.folder).filter(t => t.status !== 'completed')
          : [];
      const text = formatTaskList(tasks);
      const kb = tasks.length > 0 ? buildTaskListKeyboard(tasks) : undefined;
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...(kb ? { reply_markup: kb } : {}),
      });
      await ctx.answerCallbackQuery();
      return;
    }

    // Resolve task from short ID
    const task = getTaskByShortId(sid);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task not found' });
      return;
    }

    switch (action) {
      case 'pause': {
        updateTask(task.id, { status: 'paused' });
        const updated = getTaskById(task.id)!;
        await ctx.editMessageText(formatTaskDetail(updated), {
          parse_mode: 'HTML',
          reply_markup: buildTaskDetailKeyboard(updated),
        });
        await ctx.answerCallbackQuery({ text: 'Task paused' });
        break;
      }

      case 'resume': {
        updateTask(task.id, { status: 'active' });
        const updated = getTaskById(task.id)!;
        await ctx.editMessageText(formatTaskDetail(updated), {
          parse_mode: 'HTML',
          reply_markup: buildTaskDetailKeyboard(updated),
        });
        await ctx.answerCallbackQuery({ text: 'Task resumed' });
        break;
      }

      case 'run': {
        await ctx.answerCallbackQuery({ text: 'Task triggered!' });
        if (!taskActions) return;
        const result = await taskActions.runTaskNow(task.id);
        const numericId = extractTelegramChatId(chatId);
        if (result.success) {
          const dur = result.durationMs ? ` (${Math.round(result.durationMs / 1000)}s)` : '';
          await bot!.api.sendMessage(numericId, `Task completed${dur}: ${truncatePrompt(task.prompt, 60)}`);
        } else {
          await bot!.api.sendMessage(numericId, `Task failed: ${result.error || 'Unknown error'}`);
        }
        break;
      }

      case 'detail': {
        await ctx.editMessageText(formatTaskDetail(task), {
          parse_mode: 'HTML',
          reply_markup: buildTaskDetailKeyboard(task),
        });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'logs': {
        const logs = getTaskRunLogs(task.id, 5);
        let text = `<b>Run Logs</b> - ${escapeHtml(truncatePrompt(task.prompt, 40))}\n\n`;
        if (logs.length === 0) {
          text += 'No runs yet.';
        } else {
          for (const log of logs) {
            const dur = `${(log.duration_ms / 1000).toFixed(1)}s`;
            const time = log.run_at.replace('T', ' ').slice(0, 16);
            const status = log.status === 'success' ? 'ok' : 'err';
            text += `${time} - ${status} (${dur})\n`;
            if (log.error) text += `  ${escapeHtml(log.error.slice(0, 100))}\n`;
          }
        }
        const kb = new InlineKeyboard()
          .text('Back to Task', `t:detail:${sid}`)
          .text('Back to List', `t:back:_`);
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'del': {
        const text = `Delete this task?\n\n<b>${escapeHtml(truncatePrompt(task.prompt, 80))}</b>\n\nThis cannot be undone.`;
        const kb = new InlineKeyboard()
          .text('Yes, Delete', `t:confirm_del:${sid}`)
          .text('No, Keep', `t:detail:${sid}`);
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'confirm_del': {
        deleteTask(task.id);
        // Return to task list
        const tasks = isMain
          ? getAllTasks().filter(t => t.status !== 'completed')
          : group
            ? getTasksForGroup(group.folder).filter(t => t.status !== 'completed')
            : [];
        const text = tasks.length > 0
          ? `Task deleted.\n\n${formatTaskList(tasks)}`
          : 'Task deleted. No tasks remaining.';
        const kb = tasks.length > 0 ? buildTaskListKeyboard(tasks) : undefined;
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          ...(kb ? { reply_markup: kb } : {}),
        });
        await ctx.answerCallbackQuery({ text: 'Task deleted' });
        break;
      }

      default:
        await ctx.answerCallbackQuery({ text: 'Unknown action' });
    }
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
