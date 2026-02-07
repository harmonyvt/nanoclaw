import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { LanguageCode } from 'grammy/types';

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
import {
  ensureWaitForUserRequest,
  getOldestWaitForUserRequest,
} from './browse-host.js';
import { getTakeoverUrl } from './cua-takeover-server.js';
import { createSessionForOwner } from './dashboard-auth.js';
import { getDashboardUrl } from './dashboard-server.js';
import { downloadTelegramFile, transcribeAudio } from './media.js';
import { logger } from './logger.js';
import { ensureSandbox, getSandboxUrl } from './sandbox-manager.js';
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
  runTaskNow(
    taskId: string,
  ): Promise<{ success: boolean; error?: string; durationMs?: number }>;
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

  const active = tasks.filter((t) => t.status === 'active').length;
  const paused = tasks.filter((t) => t.status === 'paused').length;
  const completed = tasks.filter((t) => t.status === 'completed').length;

  const parts = [];
  if (active) parts.push(`${active} active`);
  if (paused) parts.push(`${paused} paused`);
  if (completed) parts.push(`${completed} done`);

  const lines = [`<b>Tasks</b> (${parts.join(', ')})\n`];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const status =
      t.status === 'active'
        ? 'active'
        : t.status === 'paused'
          ? 'paused'
          : 'done';
    const nextInfo = t.next_run
      ? ` | next: ${formatRelativeTime(t.next_run)}`
      : '';
    lines.push(
      `${i + 1}. <b>${escapeHtml(truncatePrompt(t.prompt, 40))}</b>\n` +
        `   <code>${formatSchedule(t)}</code> | ${status}${nextInfo}`,
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
    lines.push(
      `<b>Last result:</b> ${escapeHtml(task.last_result.slice(0, 200))}`,
    );
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

type SlashCommandSpec = {
  command:
    | 'tasks'
    | 'runtask'
    | 'new'
    | 'clear'
    | 'status'
    | 'update'
    | 'takeover'
    | 'dashboard'
    | 'verbose'
    | 'help';
  description: string;
  help: string;
};

const TELEGRAM_SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    command: 'tasks',
    description: 'List scheduled tasks and automations',
    help: 'List scheduled tasks and automations',
  },
  {
    command: 'runtask',
    description: 'Trigger a task immediately',
    help: 'Trigger a task immediately: /runtask <task-id>',
  },
  {
    command: 'new',
    description: 'Start a new conversation thread',
    help: 'Start a new conversation thread',
  },
  {
    command: 'clear',
    description: 'Clear conversation history',
    help: 'Clear conversation history and reset session',
  },
  {
    command: 'status',
    description: 'Show session info',
    help: 'Show session info, message count, uptime',
  },
  {
    command: 'update',
    description: 'Check and apply service update',
    help: 'Check for updates and request confirmation',
  },
  {
    command: 'takeover',
    description: 'Force CUA takeover URL',
    help: 'Force a CUA takeover URL',
  },
  {
    command: 'dashboard',
    description: 'Open the realtime log dashboard',
    help: 'Open the realtime log dashboard',
  },
  {
    command: 'verbose',
    description: 'Toggle verbose mode (show agent tool use)',
    help: 'Toggle verbose mode (show agent tool use)',
  },
  {
    command: 'help',
    description: 'List commands',
    help: 'List available commands',
  },
];

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
  chat?: { type: string };
  from?: { id: number };
}): boolean {
  if (!ctx.chat || ctx.chat.type !== 'private') return false;
  if (TELEGRAM_OWNER_ID && ctx.from?.id.toString() !== TELEGRAM_OWNER_ID)
    return false;
  return true;
}

function toLanguageCode(value?: string): LanguageCode | undefined {
  if (!value) return undefined;
  return value as LanguageCode;
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

function startSelfUpdateProcess(chatId: number): void {
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

  child.on('close', (code) => {
    if (code !== 0 && bot) {
      const tail = fs
        .readFileSync(SELF_UPDATE_LOG, 'utf-8')
        .split('\n')
        .slice(-15)
        .join('\n');
      bot.api
        .sendMessage(
          chatId,
          `Self-update failed (exit code ${code}).\n\nLast log lines:\n${tail}`,
        )
        .catch((err) => logger.error({ err }, 'Failed to send update failure message'));
    }
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
  taskActions?: TaskActionHandler,
): Promise<void> {
  bot = new Bot(TELEGRAM_BOT_TOKEN);
  const apiCommands = TELEGRAM_SLASH_COMMANDS.map((c) => ({
    command: c.command,
    description: c.description,
  }));
  const syncedCommandScopes = new Set<string>();

  async function syncChatCommandsIfNeeded(
    chatId: number,
    languageCode?: LanguageCode,
  ): Promise<void> {
    const defaultKey = `${chatId}:default`;
    const langKey = languageCode ? `${chatId}:${languageCode}` : null;
    if (
      syncedCommandScopes.has(defaultKey) &&
      (!langKey || syncedCommandScopes.has(langKey))
    ) {
      return;
    }

    try {
      await bot!.api.setMyCommands(apiCommands, {
        scope: { type: 'chat', chat_id: chatId },
      });
      syncedCommandScopes.add(defaultKey);

      if (languageCode && !syncedCommandScopes.has(langKey!)) {
        await bot!.api.setMyCommands(apiCommands, {
          scope: { type: 'chat', chat_id: chatId },
          language_code: languageCode,
        });
        syncedCommandScopes.add(langKey!);
      }
    } catch (err) {
      logger.warn(
        { err, chatId, languageCode },
        'Failed to sync Telegram commands for chat scope',
      );
    }
  }

  // Register slash commands with Telegram immediately so they appear in the command menu.
  // This runs before bot.start() since bot.api only needs the token, not full initialization.
  try {
    await bot.api.setMyCommands(apiCommands);
    // Also set commands specifically for private chats so they appear in the / menu
    await bot.api.setMyCommands(apiCommands, {
      scope: { type: 'all_private_chats' },
    });

    // Chat-specific scope has higher priority than all_private_chats.
    // If a stale chat scope exists, this ensures our latest command set is visible.
    if (TELEGRAM_OWNER_ID) {
      const ownerChatId = Number(TELEGRAM_OWNER_ID);
      if (!Number.isNaN(ownerChatId)) {
        await syncChatCommandsIfNeeded(ownerChatId);
      }
    }
    logger.info('Bot commands registered with Telegram');
  } catch (err) {
    logger.error({ err }, 'Failed to register bot commands');
  }

  // Set the persistent Menu Button (bottom-left "Open" button like BotFather)
  // This opens the dashboard as a Telegram Web App when tapped.
  const dashboardUrl = getDashboardUrl();
  if (dashboardUrl) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Dashboard',
          web_app: { url: dashboardUrl + '/app' },
        },
      });
      logger.info({ url: dashboardUrl }, 'Dashboard menu button set');
    } catch (err) {
      logger.warn({ err }, 'Failed to set dashboard menu button');
    }
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

  bot.use(async (ctx, next) => {
    if (ctx.chat && shouldAccept({ chat: ctx.chat, from: ctx.from })) {
      await syncChatCommandsIfNeeded(
        ctx.chat.id,
        toLanguageCode(ctx.from?.language_code),
      );
    }
    await next();
  });

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

  bot.command('takeover', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const senderName = ctx.from
      ? `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ''}`
      : 'Owner';
    const group = ensureRegistered(chatId, senderName);
    if (!group) {
      await ctx.reply('Could not register this chat for takeover.');
      return;
    }

    try {
      await ensureSandbox();
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to start sandbox for /takeover');
      await ctx.reply(
        'Failed to start CUA sandbox. Check Docker/sandbox logs.',
      );
      return;
    }

    const existing = getOldestWaitForUserRequest(group.folder);
    const request =
      existing ||
      ensureWaitForUserRequest(
        `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        group.folder,
        'Manual forced takeover requested from Telegram command.',
      );

    const ownerSession = createSessionForOwner();
    const takeoverUrl = getTakeoverUrl(request.token, ownerSession?.token);
    const sandboxUrl = getSandboxUrl();
    const takeoverLine = takeoverUrl
      ? `Take over CUA: ${takeoverUrl}`
      : 'Takeover URL unavailable (takeover web UI may be disabled).';
    const noVncLine = sandboxUrl ? `\nDirect noVNC: ${sandboxUrl}` : '';
    const requestLine = existing
      ? `\nReusing active request: ${request.requestId}`
      : `\nCreated request: ${request.requestId}`;

    await ctx.reply(
      `Forced takeover ready.\n${takeoverLine}${noVncLine}${requestLine}\n\nWhen done, click "Return Control To Agent" in the takeover page.\nFallback: reply "continue ${request.requestId}".`,
    );
  });

  bot.command('dashboard', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    const dashboardBaseUrl = getDashboardUrl();
    if (!dashboardBaseUrl) {
      await ctx.reply(
        'Dashboard is disabled. Set DASHBOARD_ENABLED=true to enable.',
      );
      return;
    }

    const kb = new InlineKeyboard().webApp(
      'Open Dashboard',
      dashboardBaseUrl + '/app',
    );

    await ctx.reply('Tap the button below to open the log dashboard.', {
      reply_markup: kb,
    });
  });

  bot.command('help', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const lines = TELEGRAM_SLASH_COMMANDS.map(
      (c) => `/${c.command} - ${c.help}`,
    );
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
        startSelfUpdateProcess(ctx.chat.id);
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

  // --- Task commands ---

  bot.command('tasks', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    const isMain = group && group.folder === 'main';

    // Main sees all, others see only their group
    const tasks = isMain
      ? getAllTasks().filter((t) => t.status !== 'completed')
      : group
        ? getTasksForGroup(group.folder).filter((t) => t.status !== 'completed')
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
      const dur = result.durationMs
        ? ` (${Math.round(result.durationMs / 1000)}s)`
        : '';
      await ctx.reply(`Task completed${dur}.`);
    } else {
      await ctx.reply(`Task failed: ${result.error || 'Unknown error'}`);
    }
  });

  // --- Inline keyboard callback handler ---

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.chat || !shouldAccept({ chat: ctx.chat, from: ctx.from })) return;
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
        ? getAllTasks().filter((t) => t.status !== 'completed')
        : group
          ? getTasksForGroup(group.folder).filter(
              (t) => t.status !== 'completed',
            )
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
          const dur = result.durationMs
            ? ` (${Math.round(result.durationMs / 1000)}s)`
            : '';
          await bot!.api.sendMessage(
            numericId,
            `Task completed${dur}: ${truncatePrompt(task.prompt, 60)}`,
          );
        } else {
          await bot!.api.sendMessage(
            numericId,
            `Task failed: ${result.error || 'Unknown error'}`,
          );
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
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'del': {
        const text = `Delete this task?\n\n<b>${escapeHtml(truncatePrompt(task.prompt, 80))}</b>\n\nThis cannot be undone.`;
        const kb = new InlineKeyboard()
          .text('Yes, Delete', `t:confirm_del:${sid}`)
          .text('No, Keep', `t:detail:${sid}`);
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        await ctx.answerCallbackQuery();
        break;
      }

      case 'confirm_del': {
        deleteTask(task.id);
        // Return to task list
        const tasks = isMain
          ? getAllTasks().filter((t) => t.status !== 'completed')
          : group
            ? getTasksForGroup(group.folder).filter(
                (t) => t.status !== 'completed',
              )
            : [];
        const text =
          tasks.length > 0
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
 * Send a voice message to a Telegram chat from a local OGG/Opus file.
 * Telegram requires OGG encoded with Opus for native voice message playback.
 */
export async function sendTelegramVoice(
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!bot) {
    logger.error('Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);
  await bot.api.sendVoice(numericId, new InputFile(filePath), {
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
