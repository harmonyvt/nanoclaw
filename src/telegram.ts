import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import type { RunnerHandle } from '@grammyjs/runner';
import type { LanguageCode } from 'grammy/types';

import {
  ASSISTANT_NAME,
  DEFAULT_MODEL,
  GROUPS_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  makeTelegramChatId,
  extractTelegramChatId,
  DEFAULT_PROVIDER,
  MAX_CONVERSATION_MESSAGES,
} from './config.js';
import {
  REPLICATE_TTS_PROVIDERS,
  PROVIDER_SPEAKERS,
  PROVIDER_SHORTHANDS,
  SUPPORTED_MODES,
  isReplicateTTSProvider,
} from './tts-replicate.js';
import type { ReplicateVoiceProfile } from './tts-replicate.js';
import { loadUnifiedVoiceProfile } from './tts-dispatch.js';

import {
  addModelToMenu,
  clearActiveModelOverride,
  clearMessages,
  getActiveModelOverride,
  getConversationHistory,
  getConversationStatus,
  getModelMenu,
  getAllTasks,
  getTaskById,
  getTaskByShortId,
  getTaskRunLogs,
  getTasksForGroup,
  removeModelFromMenu,
  setActiveModelOverride,
  updateTask,
  deleteTask,
  insertConversationReset,
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
import { logDebugEvent, exportDebugReport } from './debug-log.js';
import {
  buildDebugOverview,
  buildDebugServiceKeyboard,
  buildServiceLogView,
} from './debug-ui.js';
import { ensureSandbox } from './sandbox-manager.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import {
  loadSkillsForGroup,
  getSkill as getSkillFromDisk,
  deleteSkill as deleteSkillFromDisk,
  getSkillCommandsForGroup,
} from './skills.js';
import { resolveAssistantIdentity } from './soul.js';

/**
 * Callback invoked after a message is stored in the DB.
 * The host (index.ts) provides this to trigger agent processing directly
 * from the grammY handler pipeline (instead of polling).
 */
export type OnMessageStored = (msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  media_type?: string;
  media_path?: string;
}) => Promise<void>;

/**
 * Interface for triggering task actions from telegram command handlers.
 * Passed in by the host (index.ts) so telegram.ts doesn't depend on task-scheduler.
 */
export interface TaskActionHandler {
  runTaskNow(
    taskId: string,
  ): Promise<{ success: boolean; error?: string; durationMs?: number }>;
}

/**
 * Interface for interrupting a running agent from telegram command handlers.
 */
export interface InterruptHandler {
  interrupt(chatJid: string): { interrupted: boolean; message: string };
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

function markdownToTelegramHtml(text: string): string {
  let result = text;

  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });

  result = result.replace(/```([\s\S]*?)```/g, (_, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });

  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    return `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`;
  });

  result = result.replace(/\*\*([^*\n]+?)\*\*/g, (_, t) => `<b>${escapeHtml(t)}</b>`);
  result = result.replace(/__([^_\n]+?)__/g, (_, t) => `<b>${escapeHtml(t)}</b>`);

  result = result.replace(/\*([^*\n]+?)\*/g, (_, t) => `<i>${escapeHtml(t)}</i>`);
  result = result.replace(/_([^_\n]+?)_/g, (_, t) => `<i>${escapeHtml(t)}</i>`);

  result = result.replace(/^### (.+)$/gm, (_, t) => `<b>${escapeHtml(t)}</b>`);
  result = result.replace(/^## (.+)$/gm, (_, t) => `<b>${escapeHtml(t)}</b>`);
  result = result.replace(/^# (.+)$/gm, (_, t) => `<b>${escapeHtml(t)}</b>`);

  result = result.replace(/^[-*+] (.+)$/gm, '• $1');

  const lines = result.split('\n');
  const processedLines = lines.map((line) => {
    // Split into [text, tag, text, tag, ...] and escape only text segments
    const parts = line.split(/(<[^>]+>)/);
    return parts
      .map((part) => {
        if (part.startsWith('<') && part.endsWith('>')) {
          return part; // HTML tag, leave as-is
        }
        // Text segment: escape HTML entities (avoid double-escaping)
        return part
          .replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      })
      .join('');
  });

  return processedLines.join('\n');
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
const SELF_UPDATE_MARKER = path.join(
  PROJECT_ROOT,
  'data',
  'self-update-pending.json',
);
const SELF_UPDATE_CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const SELF_UPDATE_ENABLED = process.env.SELF_UPDATE_ENABLED !== 'false';
const SELF_UPDATE_BRANCH = process.env.SELF_UPDATE_BRANCH || 'main';
const SELF_UPDATE_REMOTE = process.env.SELF_UPDATE_REMOTE || 'origin';
const execFileAsync = promisify(execFile);

type PendingUpdate = {
  behind: number;
  localHead: string;
  remoteHead: string;
  containerChanged: boolean;
  expiresAt: number;
};
const pendingUpdatesByChat = new Map<string, PendingUpdate>();

let bot: Bot | undefined;
let runnerHandle: RunnerHandle | undefined;

const verboseChats = new Set<string>();
export function isVerbose(chatJid: string): boolean {
  return verboseChats.has(chatJid);
}

const thinkingDisabledChats = new Set<string>();
export function isThinkingEnabled(chatJid: string): boolean {
  return !thinkingDisabledChats.has(chatJid);
}
export function addThinkingDisabled(chatJid: string): void {
  thinkingDisabledChats.add(chatJid);
}
export function removeThinkingDisabled(chatJid: string): void {
  thinkingDisabledChats.delete(chatJid);
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
    | 'rebuild'
    | 'takeover'
    | 'dashboard'
    | 'verbose'
    | 'thinking'
    | 'stop'
    | 'debug'
    | 'mute'
    | 'tts'
    | 'voice'
    | 'soul'
    | 'model'
    | 'help'
    | 'skills'
    | 'call'
    | 'hangup'
    | 'callstatus';
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
    help: 'Show session info, identity, thread history, uptime',
  },
  {
    command: 'update',
    description: 'Check and apply service update',
    help: 'Check for updates and request confirmation',
  },
  {
    command: 'rebuild',
    description: 'Rebuild and restart without pulling',
    help: 'Re-install deps, rebuild, rebuild container, restart service',
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
    command: 'thinking',
    description: 'Toggle extended thinking on/off',
    help: 'Toggle extended thinking (reasoning visible when on, faster when off)',
  },
  {
    command: 'stop',
    description: 'Interrupt the running agent',
    help: 'Stop the currently running agent operation',
  },
  {
    command: 'debug',
    description: 'Export debug event log as JSON',
    help: 'Export debug events: /debug [24h|7d|1h]',
  },
  {
    command: 'mute',
    description: 'Toggle TTS voice messages on/off',
    help: 'Toggle TTS voice messages on/off (voice on by default)',
  },
  {
    command: 'tts',
    description: 'Switch TTS provider or speaker',
    help: '/tts [provider] [speaker]',
  },
  {
    command: 'voice',
    description: 'Configure TTS voice (design, preset, clone)',
    help: 'Configure TTS voice: /voice [design|preset|clone|reset]',
  },
  {
    command: 'soul',
    description: 'View or edit SOUL.md persona',
    help: 'Manage persona: /soul [show|reset|<change request>]',
  },
  {
    command: 'model',
    description: 'Switch AI model',
    help: 'Switch AI model: /model [add <model_id> [label] | remove]',
  },
  {
    command: 'help',
    description: 'List commands',
    help: 'List available commands',
  },
  {
    command: 'skills',
    description: 'List and run stored skills',
    help: 'List stored skills (reusable workflows)',
  },
  {
    command: 'call',
    description: 'Join voice chat for spoken conversation',
    help: 'Join a group voice chat: bot listens, transcribes, and responds with voice',
  },
  {
    command: 'hangup',
    description: 'Leave the current voice call',
    help: 'Leave the active voice call',
  },
  {
    command: 'callstatus',
    description: 'Show voice call status',
    help: 'Show active voice call info (duration, turns, activity)',
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
  localChangeCount: number;
  containerChanged: boolean;
}> {
  await runGit(['fetch', '--quiet', SELF_UPDATE_REMOTE, SELF_UPDATE_BRANCH]);
  const remoteRef = `${SELF_UPDATE_REMOTE}/${SELF_UPDATE_BRANCH}`;
  const [localHead, remoteHead, behindRaw, statusRaw] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['rev-parse', remoteRef]),
    runGit(['rev-list', '--count', `HEAD..${remoteRef}`]),
    runGit(['status', '--porcelain']),
  ]);
  const behind = Number.parseInt(behindRaw, 10);
  if (Number.isNaN(behind)) {
    throw new Error(`Unexpected git rev-list output: ${behindRaw}`);
  }
  const localChangeCount = statusRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;

  // Check if any container/ files changed between local HEAD and remote
  let containerChanged = false;
  if (behind > 0) {
    const containerDiff = await runGit([
      'diff',
      '--name-only',
      `HEAD..${remoteRef}`,
      '--',
      'container/',
    ]);
    containerChanged = containerDiff.length > 0;
  }

  return { behind, localHead, remoteHead, localChangeCount, containerChanged };
}

/**
 * Check for a self-update marker file left by the update script.
 * If found, verify HEAD matches the expected commit and report back.
 */
async function verifySelfUpdate(): Promise<void> {
  if (!fs.existsSync(SELF_UPDATE_MARKER)) return;

  let marker: {
    expectedHead: string;
    chatId: string;
    timestamp: string;
    containerRebuilt: boolean;
  };
  try {
    marker = JSON.parse(fs.readFileSync(SELF_UPDATE_MARKER, 'utf-8'));
  } catch {
    fs.unlinkSync(SELF_UPDATE_MARKER);
    return;
  } finally {
    // Always clean up the marker so we don't re-report on every restart
    try {
      fs.unlinkSync(SELF_UPDATE_MARKER);
    } catch {
      /* ignore */
    }
  }

  const numericChatId = Number(marker.chatId);
  if (!Number.isFinite(numericChatId) || !marker.expectedHead) return;

  try {
    const currentHead = await runGit(['rev-parse', 'HEAD']);
    const matched = currentHead === marker.expectedHead;
    const lines = matched
      ? [
          `Self-update verified: now running ${currentHead.slice(0, 8)} (v${APP_VERSION}).`,
          marker.containerRebuilt ? 'Agent container was rebuilt.' : '',
        ].filter(Boolean)
      : [
          `Self-update may have partially failed.`,
          `Expected: ${marker.expectedHead.slice(0, 8)}`,
          `Actual: ${currentHead.slice(0, 8)}`,
          `Check ${SELF_UPDATE_LOG} for details.`,
        ];
    await sendTelegramMessage(
      makeTelegramChatId(numericChatId),
      lines.join('\n'),
    );
  } catch (err) {
    logger.error({ module: 'telegram', err }, 'Failed to verify self-update');
  }
}

function startSelfUpdateProcess(
  chatId: number,
  opts?: { rebuildOnly?: boolean },
): void {
  if (!fs.existsSync(SELF_UPDATE_SCRIPT)) {
    throw new Error(`Self-update script is missing: ${SELF_UPDATE_SCRIPT}`);
  }

  const label = opts?.rebuildOnly ? 'rebuild' : 'update';

  fs.mkdirSync(path.dirname(SELF_UPDATE_LOG), { recursive: true });
  fs.appendFileSync(
    SELF_UPDATE_LOG,
    `[${new Date().toISOString()}] Triggered ${label} from Telegram\n`,
  );

  const outputFd = fs.openSync(SELF_UPDATE_LOG, 'a');
  const child = spawn('bash', [SELF_UPDATE_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', outputFd, outputFd],
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN,
      SELF_UPDATE_CHAT_ID: String(chatId),
      SELF_UPDATE_BRANCH,
      SELF_UPDATE_REMOTE,
      ...(opts?.rebuildOnly ? { SELF_UPDATE_REBUILD_ONLY: '1' } : {}),
    },
  });

  child.on('close', (code, signal) => {
    if (!bot) return;

    if (code === 0) {
      bot.api
        .sendMessage(
          chatId,
          'Self-update script finished successfully. Service restart may briefly interrupt this chat.',
        )
        .catch((err) =>
          logger.error(
            { module: 'telegram', err },
            'Failed to send update success message',
          ),
        );
      return;
    }

    // When systemd restarts the service, it kills the entire cgroup including
    // this script. The script exits with code=null. The signal is usually
    // SIGTERM but can also be null if the process is killed abruptly. Either
    // way, a null exit code during self-update means the restart step was
    // reached and the update succeeded.
    if (code === null) {
      logger.info(
        { module: 'telegram', signal },
        'Self-update script killed during service restart (expected)',
      );
      return;
    }

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
      .catch((err) =>
        logger.error(
          { module: 'telegram', err },
          'Failed to send update failure message',
        ),
      );
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
  taskActions?: TaskActionHandler,
  interruptHandler?: InterruptHandler,
  onMessageStored?: OnMessageStored,
): Promise<RunnerHandle> {
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Per-chat sequential ordering: messages from the same chat process in order,
  // different chats process concurrently (enabled by grammY runner).
  bot.use(sequentialize((ctx) => {
    const chatId = ctx.chat?.id.toString();
    return chatId ? [chatId] : [];
  }));

  const builtinCommands = TELEGRAM_SLASH_COMMANDS.map((c) => ({
    command: c.command,
    description: c.description,
  }));
  const syncedCommandScopes = new Set<string>();

  function getCommandsForGroup(
    groupFolder?: string,
  ): Array<{ command: string; description: string }> {
    if (!groupFolder) return builtinCommands;
    const skillCmds = getSkillCommandsForGroup(groupFolder);
    if (skillCmds.length === 0) return builtinCommands;
    // Telegram allows up to 100 commands
    const maxSkills = 100 - builtinCommands.length;
    if (skillCmds.length > maxSkills) {
      logger.warn(
        { module: 'telegram', skillCount: skillCmds.length, maxSkills },
        'Too many skills, truncating command list',
      );
    }
    return [...builtinCommands, ...skillCmds.slice(0, maxSkills)];
  }

  async function syncChatCommandsIfNeeded(
    chatId: number,
    languageCode?: LanguageCode,
    groupFolder?: string,
  ): Promise<void> {
    const defaultKey = `${chatId}:default`;
    const langKey = languageCode ? `${chatId}:${languageCode}` : null;
    if (
      syncedCommandScopes.has(defaultKey) &&
      (!langKey || syncedCommandScopes.has(langKey))
    ) {
      return;
    }

    const commands = getCommandsForGroup(groupFolder);

    try {
      await bot!.api.setMyCommands(commands, {
        scope: { type: 'chat', chat_id: chatId },
      });
      syncedCommandScopes.add(defaultKey);

      if (languageCode && !syncedCommandScopes.has(langKey!)) {
        await bot!.api.setMyCommands(commands, {
          scope: { type: 'chat', chat_id: chatId },
          language_code: languageCode,
        });
        syncedCommandScopes.add(langKey!);
      }
    } catch (err) {
      logger.warn(
        { module: 'telegram', err, chatId, languageCode },
        'Failed to sync Telegram commands for chat scope',
      );
    }
  }

  // Register slash commands with Telegram immediately so they appear in the command menu.
  // This runs before bot.start() since bot.api only needs the token, not full initialization.
  try {
    await bot.api.setMyCommands(builtinCommands);
    // Also set commands specifically for private chats so they appear in the / menu
    await bot.api.setMyCommands(builtinCommands, {
      scope: { type: 'all_private_chats' },
    });

    // Chat-specific scope has higher priority than all_private_chats.
    // If a stale chat scope exists, this ensures our latest command set is visible.
    if (TELEGRAM_OWNER_ID) {
      const ownerChatId = Number(TELEGRAM_OWNER_ID);
      if (!Number.isNaN(ownerChatId)) {
        const ownerJid = makeTelegramChatId(ownerChatId);
        const ownerGroup = registeredGroups()[ownerJid];
        await syncChatCommandsIfNeeded(ownerChatId, undefined, ownerGroup?.folder);
      }
    }
    logger.info(
      { module: 'telegram' },
      'Bot commands registered with Telegram',
    );
  } catch (err) {
    logger.error(
      { module: 'telegram', err },
      'Failed to register bot commands',
    );
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
      logger.info(
        { module: 'telegram', url: dashboardUrl },
        'Dashboard menu button set',
      );
    } catch (err) {
      logger.warn(
        { module: 'telegram', err },
        'Failed to set dashboard menu button',
      );
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
      logger.info(
        { module: 'telegram', chatId, name: senderName },
        'Auto-registered owner chat',
      );
      return newGroup;
    }
    return null;
  }

  // --- Slash command handlers ---

  bot.use(async (ctx, next) => {
    if (ctx.chat && shouldAccept({ chat: ctx.chat, from: ctx.from })) {
      const chatJid = makeTelegramChatId(ctx.chat.id);
      const group = registeredGroups()[chatJid];
      await syncChatCommandsIfNeeded(
        ctx.chat.id,
        toLanguageCode(ctx.from?.language_code),
        group?.folder,
      );
    }
    await next();
  });

  const handleConversationReset = async (
    ctx: { chat: { id: number } },
    command: 'new' | 'reset',
  ) => {
    const chatId = makeTelegramChatId(ctx.chat.id);

    // Prevent stale replies from an in-flight run started before the reset.
    if (interruptHandler) interruptHandler.interrupt(chatId);

    insertConversationReset(chatId);
    logger.info(
      { module: 'telegram', chatId, command },
      'Conversation reset command received',
    );
  };

  bot.command('new', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    await handleConversationReset(ctx, 'new');
  });

  // Alias for users who expect /reset semantics from other bots.
  bot.command('reset', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    await handleConversationReset(ctx, 'reset');
  });

  bot.command('clear', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const deleted = clearMessages(chatId);
    logger.info(
      { module: 'telegram', chatId, deleted },
      'History cleared via /clear command',
    );
    await ctx.reply(
      `Cleared ${deleted} message${deleted === 1 ? '' : 's'}.`,
    );
  });

  bot.command('status', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];

    const convoStatus = getConversationStatus(chatId);
    const messageCount = convoStatus.totalMessageCount;
    const historyWindowCount = getConversationHistory(
      chatId,
      MAX_CONVERSATION_MESSAGES,
    ).length;
    const uptimeMs = Date.now() - startTime;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

    const provider = group?.providerConfig?.provider || DEFAULT_PROVIDER;
    const statusOverride = getActiveModelOverride(chatId);
    const model = statusOverride
      ? `${statusOverride.label} (override, default: ${group?.providerConfig?.model || DEFAULT_MODEL || '(none)'})`
      : (group?.providerConfig?.model || DEFAULT_MODEL || '(default)');
    const assistantIdentity = group
      ? resolveAssistantIdentity(group.folder, ASSISTANT_NAME)
      : ASSISTANT_NAME;
    const resetAt = convoStatus.resetAt
      ? `${convoStatus.resetAt} (${formatRelativeTime(convoStatus.resetAt)})`
      : 'never';
    const threadStarted = convoStatus.threadStartedAt
      ? `${convoStatus.threadStartedAt} (${formatRelativeTime(convoStatus.threadStartedAt)})`
      : '--';
    const threadLatest = convoStatus.threadLatestAt
      ? `${convoStatus.threadLatestAt} (${formatRelativeTime(convoStatus.threadLatestAt)})`
      : '--';

    const lines = [
      `Group: ${group ? group.name : 'unregistered'}`,
      `Identity: ${assistantIdentity}`,
      `Chat: ${chatId}`,
      `Provider: ${provider}`,
      `Model: ${model}`,
      `Messages (all): ${messageCount}`,
      `Thread messages (since /new): ${convoStatus.threadMessageCount}`,
      `History sent to model: ${historyWindowCount}/${MAX_CONVERSATION_MESSAGES}`,
      `Thread reset at: ${resetAt}`,
      `Thread started at: ${threadStarted}`,
      `Thread last activity: ${threadLatest}`,
      `Uptime: ${uptimeHours}h ${uptimeMinutes}m`,
      `Version: v${APP_VERSION}`,
    ];
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
      logger.error(
        { module: 'telegram', chatId, err },
        'Failed to start sandbox for /takeover',
      );
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
    const takeoverLine = takeoverUrl
      ? `Take over CUA: ${takeoverUrl}`
      : 'Takeover URL unavailable (takeover web UI may be disabled).';
    const requestLine = existing
      ? `\nReusing active request: ${request.requestId}`
      : `\nCreated request: ${request.requestId}`;

    await ctx.reply(
      `Forced takeover ready.\n${takeoverLine}${requestLine}\n\nWhen done, click "Return Control To Agent" in the takeover page.\nFallback: reply "continue ${request.requestId}".`,
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

  bot.command('skills', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    if (!group) {
      await ctx.reply('No group registered for this chat.');
      return;
    }

    const skills = loadSkillsForGroup(group.folder);
    if (skills.length === 0) {
      await ctx.reply(
        'No skills stored yet.\n\nTeach me a workflow, then say "store this as a skill called <name>" to create one.',
      );
      return;
    }

    let text = `<b>Stored Skills</b> (${skills.length})\n\n`;
    for (const s of skills) {
      text += `/<b>${escapeHtml(s.name)}</b> - ${escapeHtml(s.description)}`;
      if (s.parameters)
        text += `\n  <i>Params: ${escapeHtml(s.parameters)}</i>`;
      text += '\n';
    }

    const kb = new InlineKeyboard();
    for (const s of skills) {
      kb.text(`Run /${s.name}`, `sk:run:${s.name}`)
        .text('Delete', `sk:del:${s.name}`)
        .row();
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
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

  // /thinking is handled inline in index.ts (like /mute) for persistence

  bot.command('stop', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    if (!interruptHandler) {
      await ctx.reply('Interrupt not available.');
      return;
    }
    const chatId = makeTelegramChatId(ctx.chat.id);
    const result = interruptHandler.interrupt(chatId);
    await ctx.reply(result.message);
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

      try {
        startSelfUpdateProcess(ctx.chat.id);
      } catch (err) {
        logger.error(
          { module: 'telegram', err },
          'Failed to start self-update process',
        );
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
      const {
        behind,
        localHead,
        remoteHead,
        localChangeCount,
        containerChanged,
      } = await checkForServiceUpdate();
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
        containerChanged,
        expiresAt: Date.now() + SELF_UPDATE_CONFIRM_WINDOW_MS,
      });

      const lines = [
        `Update available on ${SELF_UPDATE_REMOTE}/${SELF_UPDATE_BRANCH}.`,
        `Behind by ${behind} commit${behind === 1 ? '' : 's'}.`,
        localChangeCount > 0
          ? `Local changes detected: ${localChangeCount} file(s). Update will reset the working tree to HEAD first.`
          : 'Local changes detected: none.',
        containerChanged
          ? 'Agent container changes detected: image will be rebuilt.'
          : 'Agent container: no changes.',
        `Current: ${localHead.slice(0, 8)}`,
        `Latest: ${remoteHead.slice(0, 8)}`,
      ];
      const kb = new InlineKeyboard()
        .text('Confirm Update', 'update:confirm')
        .text('Cancel', 'update:cancel');
      await ctx.reply(lines.join('\n'), { reply_markup: kb });
    } catch (err) {
      logger.error({ module: 'telegram', err }, 'Failed to check for updates');
      await ctx.reply(
        'Could not check for updates. Verify git remote access and try again.',
      );
    }
  });

  bot.command('rebuild', async (ctx) => {
    if (!shouldAccept(ctx)) return;

    if (!SELF_UPDATE_ENABLED) {
      await ctx.reply('Self-update is disabled (SELF_UPDATE_ENABLED=false).');
      return;
    }

    const kb = new InlineKeyboard()
      .text('Confirm Rebuild', 'rebuild:confirm')
      .text('Cancel', 'rebuild:cancel');
    await ctx.reply(
      'This will re-install dependencies, rebuild, rebuild the agent container, and restart the service.\nNo git pull — uses the code already on disk.',
      { reply_markup: kb },
    );
  });

  // --- Model swap command ---

  function buildModelMenuText(
    chatId: string,
    group: RegisteredGroup | undefined,
  ): string {
    const override = getActiveModelOverride(chatId);
    const defaultModel = group?.providerConfig?.model || DEFAULT_MODEL || '(none)';
    const provider = group?.providerConfig?.provider || DEFAULT_PROVIDER;
    if (override) {
      return `<b>Model:</b> ${escapeHtml(override.label)} (override)\n<b>Default:</b> ${escapeHtml(String(defaultModel))}\n<b>Provider:</b> ${provider}`;
    }
    return `<b>Model:</b> ${escapeHtml(String(defaultModel))} (default)\n<b>Provider:</b> ${provider}`;
  }

  function buildModelMenuKeyboard(chatId: string): InlineKeyboard {
    const menu = getModelMenu(chatId);
    const override = getActiveModelOverride(chatId);
    const kb = new InlineKeyboard();
    for (const item of menu) {
      const prefix = item.is_active ? '\u2713 ' : '';
      kb.text(`${prefix}${item.label}`, `m:sel:${item.id}`).row();
    }
    if (override) {
      kb.text('Use Default', 'm:def').row();
    }
    if (menu.length > 0) {
      kb.text('Remove...', 'm:rml');
    }
    return kb;
  }

  bot.command('model', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    const args = ctx.match?.trim() || '';

    // /model add <model_id> [label]
    if (args.startsWith('add ')) {
      const parts = args.slice(4).trim().split(/\s+/);
      const modelId = parts[0];
      if (!modelId) {
        await ctx.reply('Usage: /model add <model_id> [label]');
        return;
      }
      const label = parts.slice(1).join(' ') || modelId;
      try {
        addModelToMenu(chatId, label, modelId);
        await ctx.reply(`Added <b>${escapeHtml(label)}</b> (${escapeHtml(modelId)}) to model menu.`, { parse_mode: 'HTML' });
      } catch (err: any) {
        if (err?.message?.includes('UNIQUE constraint')) {
          await ctx.reply(`Model ${escapeHtml(modelId)} is already in the menu.`, { parse_mode: 'HTML' });
        } else {
          throw err;
        }
      }
      return;
    }

    // /model remove — show delete UI
    if (args === 'remove') {
      const menu = getModelMenu(chatId);
      if (menu.length === 0) {
        await ctx.reply('Model menu is empty. Add models with /model add <model_id> [label]');
        return;
      }
      const kb = new InlineKeyboard();
      for (const item of menu) {
        kb.text(`\u2717 ${item.label}`, `m:del:${item.id}`).row();
      }
      kb.text('Back', 'm:back');
      await ctx.reply('<b>Remove a model:</b>', { parse_mode: 'HTML', reply_markup: kb });
      return;
    }

    // /model — show menu
    const menu = getModelMenu(chatId);
    const text = buildModelMenuText(chatId, group);
    if (menu.length === 0) {
      await ctx.reply(
        `${text}\n\nNo models in menu. Add with:\n/model add <model_id> [label]`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    const kb = buildModelMenuKeyboard(chatId);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  // --- TTS provider/speaker swap command ---

  function buildTTSStatusText(groupFolder: string): string {
    const profile = loadUnifiedVoiceProfile(groupFolder);
    let text = '<b>TTS Configuration</b>\n\n';
    if (profile && 'provider' in profile && isReplicateTTSProvider(profile.provider)) {
      const rp = profile as ReplicateVoiceProfile;
      const modeName = MODE_LABELS[rp.mode] ?? rp.mode;
      text += `Provider: <code>${rp.provider}</code>\nMode: ${modeName}`;
      if (rp.mode === 'custom_voice' && rp.custom_voice?.speaker) {
        text += `\nSpeaker: ${rp.custom_voice.speaker}`;
      } else if (rp.mode === 'voice_design' && 'voice_design' in rp && rp.voice_design?.description) {
        text += `\nDescription: <i>"${rp.voice_design.description}"</i>`;
      } else if (rp.mode === 'voice_clone') {
        text += `\nSource: reference audio`;
      }
    } else if (profile) {
      text += `Provider: <code>qwen3-tts (self-hosted)</code>\nMode: ${(profile as { mode: string }).mode}`;
    } else {
      text += 'No voice profile configured.';
    }
    return text;
  }

  function buildTTSProviderKeyboard(): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const [shorthand, fullName] of Object.entries(PROVIDER_SHORTHANDS)) {
      kb.text(shorthand, `tts:p:${shorthand}`);
    }
    return kb;
  }

  function buildTTSSpeakerKeyboard(shorthand: string): InlineKeyboard {
    const provider = PROVIDER_SHORTHANDS[shorthand];
    const speakers = PROVIDER_SPEAKERS[provider];
    const modes = SUPPORTED_MODES[provider] ?? [];
    const hasMultipleModes = modes.length > 1;
    const kb = new InlineKeyboard();
    for (let i = 0; i < speakers.length; i++) {
      kb.text(speakers[i], `tts:s:${shorthand}:${speakers[i]}`);
      if ((i + 1) % 3 === 0) kb.row();
    }
    // Back goes to mode picker if provider has multiple modes, else to provider picker
    kb.row().text('\u2190 Back', hasMultipleModes ? `tts:backm:${shorthand}` : 'tts:back');
    return kb;
  }

  const MODE_LABELS: Record<string, string> = {
    custom_voice: 'Preset Speakers',
    voice_design: 'Voice Design',
    voice_clone: 'Voice Clone',
  };

  function buildTTSModeKeyboard(shorthand: string): InlineKeyboard {
    const provider = PROVIDER_SHORTHANDS[shorthand];
    const modes = SUPPORTED_MODES[provider] ?? [];
    const kb = new InlineKeyboard();
    for (const mode of modes) {
      kb.text(MODE_LABELS[mode] ?? mode, `tts:m:${shorthand}:${mode}`).row();
    }
    kb.text('\u2190 Back', 'tts:back');
    return kb;
  }

  function applyTTSProfile(groupFolder: string, provider: ReplicateVoiceProfile['provider'], speaker: string): void {
    const existing = loadUnifiedVoiceProfile(groupFolder);
    const now = new Date().toISOString();
    const newProfile: ReplicateVoiceProfile = provider === 'qwen/qwen3-tts'
      ? {
          provider: 'qwen/qwen3-tts',
          mode: 'custom_voice',
          custom_voice: { speaker, language: 'English' },
          created_at: existing?.created_at ?? now,
          updated_at: now,
        }
      : provider === 'resemble-ai/chatterbox-turbo'
        ? {
            provider: 'resemble-ai/chatterbox-turbo',
            mode: 'custom_voice',
            custom_voice: { speaker },
            created_at: existing?.created_at ?? now,
            updated_at: now,
          }
        : {
            provider: 'minimax/speech-2.8-turbo',
            mode: 'custom_voice',
            custom_voice: { speaker },
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };

    const profilePath = path.join(GROUPS_DIR, groupFolder, 'voice_profile.json');
    fs.writeFileSync(profilePath, JSON.stringify(newProfile, null, 2));
  }

  bot.command('tts', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    if (!group) {
      await ctx.reply('No group registered for this chat.');
      return;
    }

    const args = ctx.match?.trim() || '';

    if (!args) {
      // /tts — show status + provider picker
      const text = buildTTSStatusText(group.folder) + '\n\n<b>Select provider:</b>';
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildTTSProviderKeyboard() });
      return;
    }

    const parts = args.split(/\s+/);
    const providerArg = parts[0].toLowerCase();
    const speakerArg = parts[1] || '';

    // Resolve provider
    const resolvedProvider = PROVIDER_SHORTHANDS[providerArg] ??
      (isReplicateTTSProvider(providerArg) ? providerArg as ReplicateVoiceProfile['provider'] : null);
    if (!resolvedProvider) {
      const available = Object.keys(PROVIDER_SHORTHANDS).join(', ');
      await ctx.reply(`Unknown provider: <code>${providerArg}</code>\nAvailable: ${available}`, { parse_mode: 'HTML' });
      return;
    }

    const shorthand = Object.entries(PROVIDER_SHORTHANDS).find(([, v]) => v === resolvedProvider)?.[0] ?? providerArg;

    if (!speakerArg) {
      // /tts <provider> — show mode picker (or speaker grid if only custom_voice)
      const modes = SUPPORTED_MODES[resolvedProvider] ?? [];
      if (modes.length <= 1) {
        const text = `<b>${shorthand}</b>\nSelect speaker:`;
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildTTSSpeakerKeyboard(shorthand) });
      } else {
        const text = `<b>${shorthand}</b>\nSelect mode:`;
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildTTSModeKeyboard(shorthand) });
      }
      return;
    }

    // /tts <provider> <speaker> — apply directly
    const providerSpeakers = PROVIDER_SPEAKERS[resolvedProvider];
    const match = providerSpeakers.find(s => s.toLowerCase() === speakerArg.toLowerCase());
    if (!match) {
      await ctx.reply(
        `Unknown speaker: <code>${escapeHtml(speakerArg)}</code>\nAvailable for ${resolvedProvider}:\n${providerSpeakers.join(', ')}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    applyTTSProfile(group.folder, resolvedProvider, match);
    await ctx.reply(`TTS switched to <b>${shorthand}</b> \u2014 <b>${match}</b>`, { parse_mode: 'HTML' });
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

  // --- /debug command: interactive service log viewer ---
  bot.command('debug', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const params = (ctx.match || '').trim();
    const chatId = makeTelegramChatId(ctx.chat.id);
    const group = registeredGroups()[chatId];
    const isMainGroup = group && group.folder === 'main';

    // Legacy export mode: /debug 24h, /debug export, /debug 2d
    const durationMatch = params.match(/^(\d+)([hdm])$/);
    if (durationMatch || params === 'export') {
      let since: number | undefined;
      if (durationMatch) {
        const val = parseInt(durationMatch[1], 10);
        const unit = durationMatch[2];
        const multipliers: Record<string, number> = { h: 3600000, d: 86400000, m: 60000 };
        since = Date.now() - val * multipliers[unit];
      } else {
        since = Date.now() - 24 * 60 * 60 * 1000;
      }

      const report = exportDebugReport({
        since,
        group: isMainGroup ? undefined : group?.folder,
      });
      const reportJson = JSON.stringify(report, null, 2);

      const mediaDir = path.join(GROUPS_DIR, group?.folder || 'main', 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const tmpPath = path.join(mediaDir, `debug-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, reportJson);

      try {
        const caption = `Debug events: ${report.stats.total} total, exported ${report.events.length}`;
        await sendTelegramDocument(chatId, tmpPath, caption);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      logDebugEvent('telegram', 'command_invoked', group?.folder || null, { command: 'debug', params });
      return;
    }

    // Interactive mode: show service picker
    await ctx.reply(buildDebugOverview(), {
      parse_mode: 'HTML',
      reply_markup: buildDebugServiceKeyboard(),
    });
    logDebugEvent('telegram', 'command_invoked', group?.folder || null, { command: 'debug', params: 'interactive' });
  });

  // --- Inline keyboard callback handler ---

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.chat || !shouldAccept({ chat: ctx.chat, from: ctx.from })) return;
    const data = ctx.callbackQuery.data;

    // --- Self-update inline button callbacks ---
    if (data === 'update:confirm' || data === 'update:cancel') {
      const chatId = makeTelegramChatId(ctx.chat.id);
      if (data === 'update:cancel') {
        const hadPending = pendingUpdatesByChat.delete(chatId);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.answerCallbackQuery({
          text: hadPending ? 'Update canceled.' : 'No pending update.',
        });
        return;
      }
      // confirm
      const pending = pendingUpdatesByChat.get(chatId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: 'No pending update. Run /update first.',
        });
        return;
      }
      if (Date.now() > pending.expiresAt) {
        pendingUpdatesByChat.delete(chatId);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.answerCallbackQuery({
          text: 'Confirmation expired. Run /update again.',
        });
        return;
      }
      pendingUpdatesByChat.delete(chatId);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.answerCallbackQuery({ text: 'Starting update...' });
      try {
        startSelfUpdateProcess(ctx.chat.id);
      } catch (err) {
        logger.error(
          { module: 'telegram', err },
          'Failed to start self-update process',
        );
        await ctx.reply('Failed to start update. Check logs and try again.');
      }
      return;
    }

    // --- Rebuild inline button callbacks ---
    if (data === 'rebuild:confirm' || data === 'rebuild:cancel') {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      if (data === 'rebuild:cancel') {
        await ctx.answerCallbackQuery({ text: 'Rebuild canceled.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Starting rebuild...' });
      try {
        startSelfUpdateProcess(ctx.chat.id, { rebuildOnly: true });
      } catch (err) {
        logger.error(
          { module: 'telegram', err },
          'Failed to start rebuild process',
        );
        await ctx.reply('Failed to start rebuild. Check logs and try again.');
      }
      return;
    }

    // --- Skill inline button callbacks ---
    if (data.startsWith('sk:')) {
      const skParts = data.split(':');
      if (skParts.length < 3) {
        await ctx.answerCallbackQuery({ text: 'Invalid skill action' });
        return;
      }
      const skAction = skParts[1];
      const skName = skParts.slice(2).join(':');
      // Validate skill name to prevent path traversal via crafted callback data
      if (!/^[a-z][a-z0-9_]{1,30}$/.test(skName)) {
        await ctx.answerCallbackQuery({ text: 'Invalid skill name' });
        return;
      }
      const skChatId = makeTelegramChatId(ctx.chat.id);
      const skGroup = registeredGroups()[skChatId];

      if (!skGroup) {
        await ctx.answerCallbackQuery({ text: 'No group found' });
        return;
      }

      if (skAction === 'run') {
        await ctx.answerCallbackQuery({ text: `Running /${skName}...` });
        const numericId = extractTelegramChatId(skChatId);
        try {
          const msgId = `sk-${Date.now()}`;
          const timestamp = new Date().toISOString();
          const senderName = ctx.from.first_name +
            (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
          storeTextMessage(
            msgId,
            skChatId,
            ctx.from.id.toString(),
            senderName,
            `/${skName}`,
            timestamp,
            false,
          );

          if (onMessageStored) {
            await onMessageStored({
              id: msgId, chat_jid: skChatId, sender: ctx.from.id.toString(),
              sender_name: senderName, content: `/${skName}`, timestamp,
            });
          }
        } catch (err) {
          logger.error(
            { module: 'telegram', err, skill: skName },
            'Failed to queue skill run',
          );
          await bot!.api.sendMessage(
            numericId,
            `Failed to run skill: ${skName}`,
          );
        }
        return;
      }

      if (skAction === 'del') {
        const skill = getSkillFromDisk(skGroup.folder, skName);
        if (!skill) {
          await ctx.answerCallbackQuery({ text: 'Skill not found' });
          return;
        }
        const confirmText = `Delete skill <b>/${escapeHtml(skName)}</b>?\n\n<i>${escapeHtml(skill.description)}</i>\n\nThis cannot be undone.`;
        const confirmKb = new InlineKeyboard()
          .text('Yes, Delete', `sk:confirm_del:${skName}`)
          .text('Cancel', `sk:cancel_del:${skName}`);
        await ctx.editMessageText(confirmText, {
          parse_mode: 'HTML',
          reply_markup: confirmKb,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (skAction === 'confirm_del') {
        deleteSkillFromDisk(skGroup.folder, skName);
        // Refresh Telegram commands
        const numericId = extractTelegramChatId(skChatId);
        syncedCommandScopes.delete(`${numericId}:default`);
        await syncChatCommandsIfNeeded(numericId, undefined, skGroup.folder);
        // Show updated skills list
        const skills = loadSkillsForGroup(skGroup.folder);
        const text =
          skills.length > 0
            ? `Skill deleted.\n\n<b>Remaining Skills</b> (${skills.length}):\n${skills.map((s) => `/${escapeHtml(s.name)} - ${escapeHtml(s.description)}`).join('\n')}`
            : 'Skill deleted. No skills remaining.';
        await ctx.editMessageText(text, { parse_mode: 'HTML' });
        await ctx.answerCallbackQuery({ text: 'Skill deleted' });
        return;
      }

      if (skAction === 'cancel_del') {
        await ctx.answerCallbackQuery({ text: 'Canceled' });
        // Show skills list again
        const skills = loadSkillsForGroup(skGroup.folder);
        let text = `<b>Stored Skills</b> (${skills.length})\n\n`;
        for (const s of skills) {
          text += `/<b>${escapeHtml(s.name)}</b> - ${escapeHtml(s.description)}\n`;
        }
        const kb = new InlineKeyboard();
        for (const s of skills) {
          kb.text(`Run /${s.name}`, `sk:run:${s.name}`)
            .text('Delete', `sk:del:${s.name}`)
            .row();
        }
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Unknown skill action' });
      return;
    }

    // --- TTS inline button callbacks ---
    if (data.startsWith('tts:')) {
      const ttsParts = data.split(':');
      const ttsAction = ttsParts[1];
      const ttsChatId = makeTelegramChatId(ctx.chat.id);
      const ttsGroup = registeredGroups()[ttsChatId];
      if (!ttsGroup) {
        await ctx.answerCallbackQuery({ text: 'No group registered' });
        return;
      }

      if (ttsAction === 'p') {
        // Provider selected — show mode picker (or speaker grid if only custom_voice)
        const shorthand = ttsParts[2];
        const provider = PROVIDER_SHORTHANDS[shorthand];
        if (!provider) {
          await ctx.answerCallbackQuery({ text: 'Unknown provider' });
          return;
        }
        const modes = SUPPORTED_MODES[provider] ?? [];
        if (modes.length <= 1) {
          // Only custom_voice — go straight to speaker grid
          const text = `<b>${shorthand}</b>\nSelect speaker:`;
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: buildTTSSpeakerKeyboard(shorthand),
          });
        } else {
          const text = `<b>${shorthand}</b>\nSelect mode:`;
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: buildTTSModeKeyboard(shorthand),
          });
        }
        await ctx.answerCallbackQuery();
        return;
      }

      if (ttsAction === 's') {
        // Speaker selected — apply profile
        const shorthand = ttsParts[2];
        const speaker = ttsParts[3];
        const provider = PROVIDER_SHORTHANDS[shorthand];
        if (!provider || !speaker) {
          await ctx.answerCallbackQuery({ text: 'Invalid selection' });
          return;
        }
        applyTTSProfile(ttsGroup.folder, provider, speaker);
        await ctx.editMessageText(
          `TTS switched to <b>${shorthand}</b> \u2014 <b>${speaker}</b>`,
          { parse_mode: 'HTML' },
        );
        await ctx.answerCallbackQuery({ text: `${shorthand} / ${speaker}` });
        return;
      }

      if (ttsAction === 'm') {
        // Mode selected
        const shorthand = ttsParts[2];
        const mode = ttsParts[3];
        const provider = PROVIDER_SHORTHANDS[shorthand];
        if (!provider || !mode) {
          await ctx.answerCallbackQuery({ text: 'Invalid selection' });
          return;
        }

        if (mode === 'custom_voice') {
          // Show speaker grid
          const text = `<b>${shorthand}</b>\nSelect speaker:`;
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: buildTTSSpeakerKeyboard(shorthand),
          });
          await ctx.answerCallbackQuery();
          return;
        }

        if (mode === 'voice_design') {
          // Apply voice_design with default description
          const now = new Date().toISOString();
          const existing = loadUnifiedVoiceProfile(ttsGroup.folder);
          const profile: ReplicateVoiceProfile = {
            provider: 'qwen/qwen3-tts',
            mode: 'voice_design',
            voice_design: {
              description: 'A warm, friendly, natural-sounding voice',
              language: 'English',
            },
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };
          const profilePath = path.join(GROUPS_DIR, ttsGroup.folder, 'voice_profile.json');
          fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
          await ctx.editMessageText(
            `TTS switched to <b>${shorthand}</b> — <b>Voice Design</b>\n\n` +
            `Current description: <i>"A warm, friendly, natural-sounding voice"</i>\n\n` +
            `To customize, tell the agent to update your voice design description.`,
            { parse_mode: 'HTML' },
          );
          await ctx.answerCallbackQuery({ text: 'Voice Design enabled' });
          return;
        }

        if (mode === 'voice_clone') {
          await ctx.editMessageText(
            `<b>${shorthand}</b> — <b>Voice Clone</b>\n\n` +
            `To set up voice clone:\n` +
            `1. Send a voice message or audio file as reference\n` +
            `2. Ask the agent to clone that voice\n\n` +
            `The agent will configure the voice profile for you.`,
            { parse_mode: 'HTML' },
          );
          await ctx.answerCallbackQuery({ text: 'Voice Clone info' });
          return;
        }

        await ctx.answerCallbackQuery({ text: 'Unknown mode' });
        return;
      }

      if (ttsAction === 'backm') {
        // Back to mode picker
        const shorthand = ttsParts[2];
        const provider = PROVIDER_SHORTHANDS[shorthand];
        if (!provider) {
          await ctx.answerCallbackQuery({ text: 'Unknown provider' });
          return;
        }
        const text = `<b>${shorthand}</b>\nSelect mode:`;
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: buildTTSModeKeyboard(shorthand),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (ttsAction === 'back') {
        // Back to provider picker
        const text = buildTTSStatusText(ttsGroup.folder) + '\n\n<b>Select provider:</b>';
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: buildTTSProviderKeyboard(),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Unknown TTS action' });
      return;
    }

    // --- Model menu inline button callbacks ---
    if (data.startsWith('m:')) {
      const mParts = data.split(':');
      const mAction = mParts[1];
      const mArg = mParts[2];
      const mChatId = makeTelegramChatId(ctx.chat.id);
      const mGroup = registeredGroups()[mChatId];

      if (mAction === 'sel' && mArg) {
        const menuId = Number(mArg);
        const menu = getModelMenu(mChatId);
        const item = menu.find((m) => m.id === menuId);
        if (!item) {
          await ctx.answerCallbackQuery({ text: 'Model not found' });
          return;
        }
        if (item.is_active) {
          await ctx.answerCallbackQuery({ text: 'Already active' });
          return;
        }
        setActiveModelOverride(mChatId, menuId);
        insertConversationReset(mChatId);
        if (interruptHandler) interruptHandler.interrupt(mChatId);
        await ctx.editMessageText(
          `Switched to <b>${escapeHtml(item.label)}</b> (${escapeHtml(item.model)}). Conversation cleared.`,
          { parse_mode: 'HTML' },
        );
        await ctx.answerCallbackQuery();
        return;
      }

      if (mAction === 'def') {
        clearActiveModelOverride(mChatId);
        insertConversationReset(mChatId);
        if (interruptHandler) interruptHandler.interrupt(mChatId);
        const defaultModel = mGroup?.providerConfig?.model || DEFAULT_MODEL || '(none)';
        await ctx.editMessageText(
          `Reverted to default model (${escapeHtml(String(defaultModel))}). Conversation cleared.`,
          { parse_mode: 'HTML' },
        );
        await ctx.answerCallbackQuery();
        return;
      }

      if (mAction === 'rml') {
        const menu = getModelMenu(mChatId);
        if (menu.length === 0) {
          await ctx.editMessageText('Model menu is empty.');
          await ctx.answerCallbackQuery();
          return;
        }
        const kb = new InlineKeyboard();
        for (const item of menu) {
          kb.text(`\u2717 ${item.label}`, `m:del:${item.id}`).row();
        }
        kb.text('Back', 'm:back');
        await ctx.editMessageText('<b>Remove a model:</b>', {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (mAction === 'del' && mArg) {
        const menuId = Number(mArg);
        const menu = getModelMenu(mChatId);
        const item = menu.find((m) => m.id === menuId);
        if (!item) {
          await ctx.answerCallbackQuery({ text: 'Model not found' });
          return;
        }
        const kb = new InlineKeyboard()
          .text('Yes, Remove', `m:cdl:${menuId}`)
          .text('Cancel', 'm:back');
        await ctx.editMessageText(
          `Remove <b>${escapeHtml(item.label)}</b> (${escapeHtml(item.model)}) from menu?`,
          { parse_mode: 'HTML', reply_markup: kb },
        );
        await ctx.answerCallbackQuery();
        return;
      }

      if (mAction === 'cdl' && mArg) {
        const menuId = Number(mArg);
        removeModelFromMenu(mChatId, menuId);
        // Show updated menu
        const text = buildModelMenuText(mChatId, mGroup);
        const menu = getModelMenu(mChatId);
        if (menu.length === 0) {
          await ctx.editMessageText(
            `Model removed.\n\n${text}\n\nNo models in menu. Add with:\n/model add <model_id> [label]`,
            { parse_mode: 'HTML' },
          );
        } else {
          const kb = buildModelMenuKeyboard(mChatId);
          await ctx.editMessageText(`Model removed.\n\n${text}`, {
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        }
        await ctx.answerCallbackQuery({ text: 'Removed' });
        return;
      }

      if (mAction === 'back') {
        const text = buildModelMenuText(mChatId, mGroup);
        const menu = getModelMenu(mChatId);
        if (menu.length === 0) {
          await ctx.editMessageText(
            `${text}\n\nNo models in menu. Add with:\n/model add <model_id> [label]`,
            { parse_mode: 'HTML' },
          );
        } else {
          const kb = buildModelMenuKeyboard(mChatId);
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        }
        await ctx.answerCallbackQuery();
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Unknown model action' });
      return;
    }

    // --- Debug UI inline button callbacks ---
    if (data.startsWith('d:')) {
      const dParts = data.split(':');
      const dAction = dParts[1];

      if (dAction === 'back') {
        await ctx.editMessageText(buildDebugOverview(), {
          parse_mode: 'HTML',
          reply_markup: buildDebugServiceKeyboard(),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (dAction === 'export') {
        const chatId = makeTelegramChatId(ctx.chat.id);
        const group = registeredGroups()[chatId];
        const isMainGroup = group && group.folder === 'main';
        const report = exportDebugReport({
          since: Date.now() - 24 * 60 * 60 * 1000,
          group: isMainGroup ? undefined : group?.folder,
        });
        const reportJson = JSON.stringify(report, null, 2);

        const mediaDir = path.join(GROUPS_DIR, group?.folder || 'main', 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const tmpPath = path.join(mediaDir, `debug-${Date.now()}.json`);
        fs.writeFileSync(tmpPath, reportJson);

        try {
          const caption = `Debug events: ${report.stats.total} total, exported ${report.events.length}`;
          await sendTelegramDocument(chatId, tmpPath, caption);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        await ctx.answerCallbackQuery({ text: 'Report exported' });
        return;
      }

      if (dAction === 'svc') {
        const service = dParts[2];
        const { text, keyboard } = buildServiceLogView(service);
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (dAction === 'err') {
        const service = dParts[2];
        const { text, keyboard } = buildServiceLogView(service, { minLevel: 50 });
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (dAction === 'wrn') {
        const service = dParts[2];
        const { text, keyboard } = buildServiceLogView(service, { minLevel: 40 });
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (dAction === 'pg') {
        const service = dParts[2];
        const page = parseInt(dParts[3] || '0', 10);
        const filter = dParts[4]; // optional: 'err' or 'wrn'
        const minLevel = filter === 'err' ? 50 : filter === 'wrn' ? 40 : undefined;
        const { text, keyboard } = buildServiceLogView(service, { page, minLevel });
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Unknown debug action' });
      return;
    }

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

  // Commands handled by grammY bot.command() handlers above — skip in message:text
  const grammyHandledCommands = new Set([
    'new', 'clear', 'status', 'takeover', 'dashboard', 'help', 'skills',
    'verbose', 'thinking', 'stop', 'update', 'rebuild', 'tasks', 'runtask',
    'reset', 'model', 'debug',
  ]);

  bot.on('message:text', async (ctx) => {
    if (!shouldAccept(ctx)) return;
    const firstEntity = ctx.message.entities?.[0];
    if (firstEntity?.type === 'bot_command' && firstEntity.offset === 0) {
      // Extract command name (strip leading / and optional @botname suffix)
      const cmdText = ctx.message.text.slice(1, firstEntity.length).split('@')[0].toLowerCase();
      if (grammyHandledCommands.has(cmdText)) return;
    }

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

      if (onMessageStored) {
        await onMessageStored({
          id: msgId, chat_jid: chatId, sender, sender_name: senderName,
          content, timestamp,
        });
      }
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
        { module: 'telegram', msgId, size: voice.file_size },
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

      if (onMessageStored) {
        await onMessageStored({
          id: msgId, chat_jid: chatId, sender, sender_name: senderName,
          content, timestamp, media_type: 'voice', media_path: localPath,
        });
      }
    } catch (err) {
      logger.error(
        { module: 'telegram', msgId, err },
        'Error processing voice message',
      );
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
        { module: 'telegram', msgId, size: audio.file_size },
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

      if (onMessageStored) {
        await onMessageStored({
          id: msgId, chat_jid: chatId, sender, sender_name: senderName,
          content, timestamp, media_type: 'audio', media_path: localPath,
        });
      }
    } catch (err) {
      logger.error(
        { module: 'telegram', msgId, err },
        'Error processing audio message',
      );
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
        { module: 'telegram', msgId, size: photo.file_size },
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

      if (onMessageStored) {
        await onMessageStored({
          id: msgId, chat_jid: chatId, sender, sender_name: senderName,
          content, timestamp, media_type: 'photo', media_path: localPath,
        });
      }
    } catch (err) {
      logger.error(
        { module: 'telegram', msgId, err },
        'Error processing photo message',
      );
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
        { module: 'telegram', msgId, size: doc.file_size },
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

      if (onMessageStored) {
        await onMessageStored({
          id: msgId, chat_jid: chatId, sender, sender_name: senderName,
          content, timestamp, media_type: 'document', media_path: localPath,
        });
      }
    } catch (err) {
      logger.error(
        { module: 'telegram', msgId, err },
        'Error processing document message',
      );
    }
  });

  bot.catch((err) => {
    logger.error({ module: 'telegram', err: err.error }, 'Telegram bot error');
  });

  // Start concurrent polling via grammY runner (non-blocking)
  const handle = run(bot);
  runnerHandle = handle;

  logger.info({ module: 'telegram' }, 'Connected to Telegram (runner mode)');

  if (TELEGRAM_OWNER_ID) {
    try {
      const ownerChatId = makeTelegramChatId(Number(TELEGRAM_OWNER_ID));
      await sendTelegramMessage(ownerChatId, `Online v${APP_VERSION}`);
    } catch (err) {
      logger.error(
        { module: 'telegram', err },
        'Failed to send startup message to owner',
      );
    }
  }

  // After a self-update restart, verify and report back
  await verifySelfUpdate();

  return handle;
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
    logger.error({ module: 'telegram' }, 'Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);
  const htmlText = markdownToTelegramHtml(text);

  const SELF_CLOSING = new Set(['br', 'hr', 'img']);

  const getOpenTags = (str: string): string[] => {
    const tags: string[] = [];
    const tagRegex = /<\/?(\w+)[^>]*>/g;
    let match;
    while ((match = tagRegex.exec(str)) !== null) {
      const tagName = match[1].toLowerCase();
      if (match[0].startsWith('</')) {
        const idx = tags.lastIndexOf(tagName);
        if (idx !== -1) tags.splice(idx, 1);
      } else if (!SELF_CLOSING.has(tagName) && !match[0].endsWith('/>')) {
        tags.push(tagName);
      }
    }
    return tags;
  };

  const chunks: string[] = [];
  let remaining = htmlText;
  let pendingOpenTags: string[] = [];

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      if (pendingOpenTags.length > 0) {
        const reopenTags = pendingOpenTags
          .map((t) => `<${t}>`)
          .join('');
        chunks.push(reopenTags + remaining);
      } else {
        chunks.push(remaining);
      }
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) splitAt = TELEGRAM_MAX_LENGTH;

    const chunk = remaining.slice(0, splitAt);
    const openTagsAtSplit = getOpenTags(chunk);

    const closeTags = [...openTagsAtSplit]
      .reverse()
      .map((t) => `</${t}>`)
      .join('');

    const chunkWithCloses =
      pendingOpenTags.map((t) => `<${t}>`).join('') + chunk + closeTags;

    if (chunkWithCloses.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(chunkWithCloses);
      pendingOpenTags = openTagsAtSplit;
      remaining = remaining.slice(splitAt).trimStart();
    } else {
      // Chunk + tag overhead exceeds limit; strip HTML and send as plain text
      chunks.push(chunk.replace(/<\/?[^>]+>/g, ''));
      pendingOpenTags = [];
      remaining = remaining.slice(splitAt).trimStart();
    }
  }

  for (const chunk of chunks) {
    await bot.api.sendMessage(numericId, chunk, { parse_mode: 'HTML' });
  }
  logDebugEvent('telegram', 'api_send_message', null, {
    chatId,
    chunkCount: chunks.length,
    totalLength: htmlText.length,
  });
}

/**
 * Send an italic HTML status message and return its message_id.
 * Used for the thinking/tool activity indicator.
 */
export async function sendTelegramStatusMessage(
  chatId: string,
  text: string,
): Promise<number | null> {
  if (!bot) return null;
  const numericId = extractTelegramChatId(chatId);
  try {
    const msg = await bot.api.sendMessage(
      numericId,
      `<i>${escapeHtml(text)}</i>`,
      {
        parse_mode: 'HTML',
      },
    );
    return msg.message_id;
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, err },
      'Failed to send status message',
    );
    return null;
  }
}

/**
 * Edit an existing status message in-place with new italic text.
 */
export async function editTelegramStatusMessage(
  chatId: string,
  messageId: number,
  text: string,
): Promise<boolean> {
  if (!bot) return false;
  const numericId = extractTelegramChatId(chatId);
  try {
    await bot.api.editMessageText(
      numericId,
      messageId,
      `<i>${escapeHtml(text)}</i>`,
      {
        parse_mode: 'HTML',
      },
    );
    return true;
  } catch (err) {
    // Telegram returns 400 if content is identical or message was deleted
    logger.debug(
      { module: 'telegram', chatId, messageId, err },
      'Failed to edit status message',
    );
    return false;
  }
}

/**
 * Delete a Telegram message. Silently ignores failures.
 */
export async function deleteTelegramMessage(
  chatId: string,
  messageId: number,
): Promise<void> {
  if (!bot) return;
  const numericId = extractTelegramChatId(chatId);
  try {
    await bot.api.deleteMessage(numericId, messageId);
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, messageId, err },
      'Failed to delete status message',
    );
  }
}

/**
 * Send a plain text message and return its message_id for later editing.
 */
export async function sendTelegramMessageWithId(
  chatId: string,
  text: string,
): Promise<number | null> {
  if (!bot) return null;
  const numericId = extractTelegramChatId(chatId);
  try {
    const msg = await bot.api.sendMessage(numericId, text);
    return msg.message_id;
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, err },
      'Failed to send message with ID',
    );
    return null;
  }
}

/**
 * Edit an existing plain text message in-place.
 */
export async function editTelegramMessageText(
  chatId: string,
  messageId: number,
  text: string,
): Promise<boolean> {
  if (!bot) return false;
  const numericId = extractTelegramChatId(chatId);
  try {
    await bot.api.editMessageText(numericId, messageId, text);
    return true;
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, messageId, err },
      'Failed to edit message text',
    );
    return false;
  }
}

/**
 * Send a photo to a Telegram chat from a local file path.
 */
export async function sendTelegramPhoto(
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<number | null> {
  if (!bot) {
    logger.error({ module: 'telegram' }, 'Telegram bot not initialized');
    return null;
  }

  const numericId = extractTelegramChatId(chatId);
  const msg = await bot.api.sendPhoto(numericId, new InputFile(filePath), {
    caption,
  });
  logDebugEvent('telegram', 'api_send_photo', null, { chatId });
  return msg.message_id;
}

/**
 * Edit an existing photo message in-place with a new image.
 */
export async function editTelegramPhoto(
  chatId: string,
  messageId: number,
  filePath: string,
  caption?: string,
): Promise<boolean> {
  if (!bot) return false;
  const numericId = extractTelegramChatId(chatId);
  try {
    await bot.api.editMessageMedia(numericId, messageId, {
      type: 'photo',
      media: new InputFile(filePath),
      caption,
    });
    return true;
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, messageId, err },
      'Failed to edit photo message',
    );
    return false;
  }
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
    logger.error({ module: 'telegram' }, 'Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);
  await bot.api.sendVoice(numericId, new InputFile(filePath), {
    caption,
  });
  logDebugEvent('telegram', 'api_send_voice', null, { chatId });
}

/**
 * Send a document/file to a Telegram chat from a local file path.
 */
export async function sendTelegramDocument(
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!bot) {
    logger.error({ module: 'telegram' }, 'Telegram bot not initialized');
    return;
  }

  const numericId = extractTelegramChatId(chatId);
  await bot.api.sendDocument(numericId, new InputFile(filePath), {
    caption,
  });
  logDebugEvent('telegram', 'api_send_document', null, { chatId, filePath });
}

/**
 * Send a typing indicator (chat action) to a Telegram chat.
 */
export async function setTelegramTyping(chatId: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.sendChatAction(extractTelegramChatId(chatId), 'typing');
  } catch (err) {
    logger.debug(
      { module: 'telegram', chatId, err },
      'Failed to send Telegram typing action',
    );
  }
}

/**
 * Re-register Telegram commands for a specific chat to include updated skill commands.
 * Called by the host when a skill_changed IPC event is processed.
 */
export async function refreshSkillCommands(
  chatJid: string,
  groupFolder: string,
): Promise<void> {
  if (!bot) return;
  const numericId = extractTelegramChatId(chatJid);

  // Build commands with skills
  const builtinCmds = TELEGRAM_SLASH_COMMANDS.map((c) => ({
    command: c.command,
    description: c.description,
  }));
  const skillCmds = getSkillCommandsForGroup(groupFolder);
  const maxSkills = 100 - builtinCmds.length;
  const commands = [...builtinCmds, ...skillCmds.slice(0, maxSkills)];

  try {
    await bot.api.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: numericId },
    });
    logger.info(
      {
        module: 'telegram',
        chatJid,
        groupFolder,
        skillCount: skillCmds.length,
      },
      'Skill commands refreshed',
    );
  } catch (err) {
    logger.error(
      { module: 'telegram', err, chatJid, groupFolder },
      'Failed to refresh skill commands',
    );
  }
}

/**
 * Gracefully stop the Telegram bot.
 * Waits for in-flight handlers to complete before returning.
 */
export async function stopTelegram(): Promise<void> {
  if (runnerHandle) {
    if (runnerHandle.isRunning()) {
      await runnerHandle.stop();
    }
    runnerHandle = undefined;
    logger.info({ module: 'telegram' }, 'Telegram bot stopped');
  }
}
