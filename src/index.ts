import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CUA_SANDBOX_IMAGE,
  CUA_SANDBOX_IMAGE_IS_LEGACY,
  CUA_SANDBOX_PLATFORM,
  DATA_DIR,
  DEBUG_THREADS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AvailableGroup,
  cleanupOrphanPersistentContainers,
  interruptContainer,
  killAllContainers,
  runContainerAgent,
  startContainerIdleCleanup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  initDatabase,
} from './db.js';
import { runTaskNow, startSchedulerLoop } from './task-scheduler.js';
import {
  connectTelegram,
  isVerbose,
  isThinkingEnabled,
  sendTelegramDocument,
  sendTelegramMessage,
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
} from './telegram.js';
import type { SessionManager, TaskActionHandler, InterruptHandler } from './telegram.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import {
  detectEmotionFromText,
  formatFreyaText,
  isFreyaEnabled,
  looksLikeCode,
  parseEmotion,
  synthesizeSpeech,
} from './tts.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import {
  isSupermemoryEnabled,
  retrieveMemories,
  storeInteraction,
  formatMemoryContext,
} from './supermemory.js';
import {
  cancelWaitingRequests,
  processBrowseRequest,
  resolveWaitForUser,
  hasWaitingRequests,
  disconnectBrowser,
  ensureWaitForUserRequest,
} from './browse-host.js';
import { cleanupOldMedia } from './media.js';
import { getSkill, getSkillNames } from './skills.js';
import {
  cleanupSandbox,
  ensureSandbox,
  startIdleWatcher,
} from './sandbox-manager.js';
import {
  getTakeoverUrl,
  startCuaTakeoverServer,
  stopCuaTakeoverServer,
} from './cua-takeover-server.js';
import { createSessionForOwner } from './dashboard-auth.js';
import {
  initLogSync,
  stopLogSync,
  pruneOldLogEntries,
} from './log-sync.js';
import {
  startDashboardServer,
  stopDashboardServer,
} from './dashboard-server.js';
import {
  initTailscaleServe,
  stopTailscaleServe,
} from './tailscale-serve.js';
import { emitCuaActivity } from './cua-activity.js';
import { initTrajectoryPersistence } from './cua-trajectory.js';

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
type CuaUsageStats = {
  total: number;
  ok: number;
  failed: number;
  recent: string[];
};
const cuaUsageByGroup: Map<string, CuaUsageStats> = new Map();

// ─── Thinking Status Message Tracking ────────────────────────────────────────

interface ActiveStatusMessage {
  chatJid: string;
  messageId: number;
  extraMessageIds: number[];
  currentText: string;
  lastEditTime: number;
}

/** Active italic status messages keyed by group folder */
const activeStatusMessages = new Map<string, ActiveStatusMessage>();

// ─── CUA Log Message Tracking ────────────────────────────────────────────────

interface ActiveCuaLogMessage {
  chatJid: string;
  textMessageId: number | null;
  screenshotMessageId: number | null;
  lastText: string;
}

/** Active CUA log messages keyed by group folder (edit-in-place) */
const activeCuaLogMessages = new Map<string, ActiveCuaLogMessage>();

/** Minimum interval between Telegram message edits (ms) */
const STATUS_EDIT_INTERVAL_MS = 2500;

/** Tool names that shouldn't appear as status (agent sending its reply) */
const HIDDEN_TOOLS = new Set(['send_message', 'send_file', 'send_voice']);

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Claude SDK built-in tools
  Bash: 'running command', Read: 'reading file', Write: 'writing file',
  Edit: 'editing file', Glob: 'searching files', Grep: 'searching code',
  WebSearch: 'searching the web', WebFetch: 'fetching page',
  // Browser tools
  browse_navigate: 'browsing', browse_snapshot: 'reading page',
  browse_click: 'clicking', browse_click_xy: 'clicking',
  browse_fill: 'filling form', browse_type_at_xy: 'typing',
  browse_perform: 'performing actions', browse_screenshot: 'taking screenshot',
  browse_wait_for_user: 'waiting for you', browse_go_back: 'going back',
  browse_close: 'closing browser', browse_extract_file: 'extracting file',
  browse_upload_file: 'uploading file', browse_evaluate: 'running script',
  // Firecrawl
  firecrawl_scrape: 'scraping page', firecrawl_crawl: 'crawling site',
  firecrawl_map: 'mapping URLs',
  // Memory
  memory_save: 'saving to memory', memory_search: 'searching memory',
  // Tasks
  schedule_task: 'scheduling task', list_tasks: 'checking tasks',
  pause_task: 'pausing task', resume_task: 'resuming task',
  cancel_task: 'cancelling task', register_group: 'registering group',
};

function humanizeToolName(rawName: string): string {
  const name = rawName.replace(/^mcp__nanoclaw__/, '');
  return TOOL_DISPLAY_NAMES[name] || name.replace(/_/g, ' ');
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (isTyping) await setTelegramTyping(jid);
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { module: 'index', groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { module: 'index', jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid.startsWith('tg:'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Check if user is saying "continue" to unblock a browse_wait_for_user request.
  // Supports both: "continue" and "continue <requestId>".
  const continueMatch = content.match(/^continue(?:\s+(\S+))?$/i);
  if (continueMatch) {
    const requestId = continueMatch[1];
    const hasPendingInGroup = hasWaitingRequests(group.folder);
    const resolved = resolveWaitForUser(group.folder, requestId);
    if (resolved) {
      logger.info(
        { module: 'index', chatJid: msg.chat_jid, groupFolder: group.folder, requestId },
        'Browse wait_for_user resolved by user',
      );
      return;
    }

    // If user intended to continue a paused browse flow, acknowledge invalid ID
    // or missing pending waits and avoid routing this as a normal agent prompt.
    if (requestId || hasPendingInGroup) {
      if (requestId) {
        await sendMessage(
          msg.chat_jid,
          `No pending wait request found for ID: ${requestId}`,
        );
      } else {
        await sendMessage(
          msg.chat_jid,
          'No pending wait request found for this chat.',
        );
      }
      return;
    }
  }

  // Check if message is a skill invocation: /skill_name [params]
  const skillMatch = content.match(/^\/([a-z][a-z0-9_]{1,30})(?:\s+(.*))?$/);
  if (skillMatch) {
    const [, skillName, skillParams] = skillMatch;
    const skill = getSkill(group.folder, skillName);
    if (skill) {
      logger.info(
        { module: 'index', skill: skillName, group: group.name, params: skillParams },
        'Skill invocation detected',
      );

      // Build prompt with skill instructions injected
      const escapeXml = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let skillXml = `<skill name="${skillName}"`;
      if (skillParams) skillXml += ` parameters="${escapeXml(skillParams)}"`;
      if (skill.parameters) skillXml += ` accepts="${escapeXml(skill.parameters)}"`;
      skillXml += `>\n${escapeXml(skill.instructions)}\n</skill>`;

      // Get messages for context (same as normal flow)
      const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
      const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

      let memoryXml = '';
      if (isSupermemoryEnabled()) {
        const latestMessage = missedMessages[missedMessages.length - 1]?.content || '';
        const memories = await retrieveMemories(group.folder, latestMessage);
        if (memories) memoryXml = formatMemoryContext(memories);
      }

      const lines = missedMessages.map((m) => {
        const escapeXml = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        let mediaAttrs = '';
        if (m.media_type && m.media_path) {
          const groupDir = path.join(GROUPS_DIR, group.folder);
          const containerPath = m.media_path.startsWith(groupDir)
            ? '/workspace/group' + m.media_path.slice(groupDir.length)
            : m.media_path;
          mediaAttrs = ` media_type="${escapeXml(m.media_type)}" media_path="${escapeXml(containerPath)}"`;
        }
        return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttrs}>${escapeXml(m.content)}</message>`;
      });
      const messagesXml = `<messages>\n${lines.join('\n')}\n</messages>`;

      // Compose: memory + skill + messages
      const parts = [memoryXml, skillXml, messagesXml].filter(Boolean);
      const prompt = parts.join('\n\n');

      await setTyping(msg.chat_jid, true);
      const response = await runAgent(group, prompt, msg.chat_jid, { isSkillInvocation: true });
      await setTyping(msg.chat_jid, false);

      if (response) {
        lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
        saveState();

        // Strip voice separator if present (skill responses are typically text)
        const voiceSep = '---voice---';
        const sepIndex = response.indexOf(voiceSep);
        const cleanText = sepIndex !== -1
          ? response.replace(voiceSep, '').trim()
          : response;
        if (cleanText && !cleanText.startsWith('[') && !cleanText.endsWith('queued')) {
          await sendMessage(msg.chat_jid, cleanText);
        }

        if (isSupermemoryEnabled()) {
          void storeInteraction(group.folder, messagesXml, response, {
            threadId: sessions[group.folder],
            timestamp: msg.timestamp,
            groupName: group.name,
          });
        }
      }
      return;
    }
  }

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  // Retrieve relevant memories from Supermemory (non-blocking)
  let memoryXml = '';
  if (isSupermemoryEnabled()) {
    const latestMessage =
      missedMessages[missedMessages.length - 1]?.content || '';
    const memories = await retrieveMemories(group.folder, latestMessage);
    if (memories) memoryXml = formatMemoryContext(memories);
  }

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // Build optional media attributes
    let mediaAttrs = '';
    if (m.media_type && m.media_path) {
      // Translate host path to container path: groups/{folder}/media/file -> /workspace/group/media/file
      const groupDir = path.join(GROUPS_DIR, group.folder);
      const containerPath = m.media_path.startsWith(groupDir)
        ? '/workspace/group' + m.media_path.slice(groupDir.length)
        : m.media_path;
      mediaAttrs = ` media_type="${escapeXml(m.media_type)}" media_path="${escapeXml(containerPath)}"`;
    }

    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttrs}>${escapeXml(m.content)}</message>`;
  });
  const messagesXml = `<messages>\n${lines.join('\n')}\n</messages>`;
  const prompt = memoryXml
    ? `${memoryXml}\n${messagesXml}`
    : messagesXml;

  if (!prompt) return;

  logger.info(
    { module: 'index', group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  await setTyping(msg.chat_jid, true);

  // Send italic thinking status message if enabled for this chat
  if (isThinkingEnabled(msg.chat_jid)) {
    const statusMsgId = await sendTelegramStatusMessage(msg.chat_jid, 'thinking');
    if (statusMsgId) {
      activeStatusMessages.set(group.folder, {
        chatJid: msg.chat_jid,
        messageId: statusMsgId,
        extraMessageIds: [],
        currentText: 'thinking',
        lastEditTime: Date.now(),
      });
    }
  }

  const response = await runAgent(group, prompt, msg.chat_jid);

  await setTyping(msg.chat_jid, false);

  // Clean up the thinking status message(s)
  const statusEntry = activeStatusMessages.get(group.folder);
  if (statusEntry) {
    activeStatusMessages.delete(group.folder);
    await deleteTelegramMessage(statusEntry.chatJid, statusEntry.messageId);
    for (const extraId of statusEntry.extraMessageIds) {
      await deleteTelegramMessage(statusEntry.chatJid, extraId);
    }
  }

  // Clean up CUA log messages
  const cuaEntry = activeCuaLogMessages.get(group.folder);
  if (cuaEntry) {
    activeCuaLogMessages.delete(group.folder);
    if (cuaEntry.textMessageId) await deleteTelegramMessage(cuaEntry.chatJid, cuaEntry.textMessageId);
    if (cuaEntry.screenshotMessageId) await deleteTelegramMessage(cuaEntry.chatJid, cuaEntry.screenshotMessageId);
  }

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    let text = response;
    if (DEBUG_THREADS) {
      const threadId = sessions[group.folder];
      if (threadId) {
        text += `\n[thread: ${threadId.slice(0, 8)}]`;
      }
    }

    // Auto-TTS: parse structured voice response (---voice--- separator)
    const voiceSep = '---voice---';
    const sepIndex = text.indexOf(voiceSep);

    if (isFreyaEnabled()) {
      let voicePart: string;
      let textPart: string | null;

      if (sepIndex !== -1) {
        // Structured: voice summary + text follow-up
        voicePart = text.slice(0, sepIndex).trim();
        textPart = text.slice(sepIndex + voiceSep.length).trim();
      } else if (!looksLikeCode(text) && text.length <= 500) {
        // Short non-code response: voice only
        voicePart = text;
        textPart = null;
      } else {
        // Long or code-heavy with no separator: text only
        voicePart = '';
        textPart = text;
      }

      if (voicePart) {
        try {
          const emotion = detectEmotionFromText(voicePart);
          const markedText = formatFreyaText(voicePart, emotion);
          const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
          const oggPath = await synthesizeSpeech(markedText, mediaDir);
          await sendTelegramVoice(msg.chat_jid, oggPath);
        } catch (err) {
          logger.error({ module: 'index', err }, 'Auto-TTS failed, sending as text');
          // On TTS failure, prepend voice part back to text
          textPart = textPart
            ? `${voicePart}\n\n${textPart}`
            : voicePart;
        }
      }

      if (textPart) {
        await sendMessage(msg.chat_jid, textPart);
      }
    } else {
      // Freya disabled: strip separator and send as plain text
      const cleanText =
        sepIndex !== -1 ? text.replace(voiceSep, '').trim() : text;
      await sendMessage(msg.chat_jid, cleanText);
    }

    // Store interaction to Supermemory (non-blocking)
    if (isSupermemoryEnabled()) {
      void storeInteraction(group.folder, messagesXml, response, {
        threadId: sessions[group.folder],
        timestamp: msg.timestamp,
        groupName: group.name,
      });
    }
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  opts?: { isSkillInvocation?: boolean },
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const provider = group.providerConfig?.provider || DEFAULT_PROVIDER;
  const model = group.providerConfig?.model || DEFAULT_MODEL || undefined;

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      isSkillInvocation: opts?.isSkillInvocation,
      assistantName: ASSISTANT_NAME,
      provider,
      model,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { module: 'index', group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ module: 'index', group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(jid, text);
    logger.info({ module: 'index', jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ module: 'index', jid, err }, 'Failed to send message');
  }
}

function getChatJidForGroup(groupFolder: string): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  )?.[0];
}

function truncateForTelegram(input: string, max = 80): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function describeCuaActionStart(
  action: string,
  params: Record<string, unknown>,
): string | null {
  switch (action) {
    case 'navigate': {
      const url = truncateForTelegram(String(params.url || ''), 120);
      return url ? `Navigating to ${url}` : 'Navigating';
    }
    case 'click': {
      const selector = truncateForTelegram(String(params.selector || ''), 80);
      return selector ? `Clicking ${selector}` : 'Clicking';
    }
    case 'fill': {
      const selector = truncateForTelegram(String(params.selector || ''), 80);
      const valueLength = String(params.value || '').length;
      return selector
        ? `Filling ${selector} (${valueLength} chars)`
        : `Filling input (${valueLength} chars)`;
    }
    case 'screenshot':
      return 'Taking screenshot';
    case 'scroll': {
      const dy = Number(params.deltaY ?? params.dy ?? 0);
      const dx = Number(params.deltaX ?? params.dx ?? 0);
      return `Scrolling (dx=${dx}, dy=${dy})`;
    }
    case 'go_back':
      return 'Navigating back';
    case 'snapshot':
      return 'Capturing page snapshot';
    case 'close':
      return 'Closing browser tab';
    case 'click_xy': {
      const x = params.x;
      const y = params.y;
      return x != null && y != null ? `Clicking at (${x}, ${y})` : 'Clicking at coordinates';
    }
    case 'type_at_xy': {
      const x = params.x;
      const y = params.y;
      const len = String(params.text || '').length;
      return x != null && y != null
        ? `Typing at (${x}, ${y}) (${len} chars)`
        : `Typing at coordinates (${len} chars)`;
    }
    case 'perform': {
      const steps = Array.isArray(params.steps) ? params.steps : [];
      return steps.length > 0
        ? `Performing ${steps.length} action${steps.length === 1 ? '' : 's'}`
        : 'Performing actions';
    }
    case 'extract_file': {
      const name = String(params.path || params.filename || 'file');
      return `Extracting ${name}`;
    }
    case 'upload_file': {
      const name = String(params.path || params.filename || 'file');
      return `Uploading ${name}`;
    }
    case 'evaluate':
      return 'Evaluating script';
    case 'wait_for_user':
      return 'Waiting for user';
    default:
      return null;
  }
}

function updateCuaUsage(
  groupFolder: string,
  action: string,
  status: 'ok' | 'error',
): CuaUsageStats {
  const current = cuaUsageByGroup.get(groupFolder) || {
    total: 0,
    ok: 0,
    failed: 0,
    recent: [],
  };
  current.total += 1;
  if (status === 'ok') current.ok += 1;
  else current.failed += 1;
  current.recent.push(`${action}:${status}`);
  if (current.recent.length > 6) {
    current.recent = current.recent.slice(-6);
  }
  cuaUsageByGroup.set(groupFolder, current);
  return current;
}

/**
 * Update or create the in-place CUA log message for a group.
 * Edits existing message if present, otherwise sends a new one.
 */
async function updateCuaLogMessage(
  groupFolder: string,
  chatJid: string,
  text: string,
): Promise<void> {
  let entry = activeCuaLogMessages.get(groupFolder);
  if (!entry) {
    entry = { chatJid, textMessageId: null, screenshotMessageId: null, lastText: '' };
    activeCuaLogMessages.set(groupFolder, entry);
  }

  if (text === entry.lastText) return;

  if (entry.textMessageId) {
    const edited = await editTelegramMessageText(chatJid, entry.textMessageId, text);
    if (edited) {
      entry.lastText = text;
      return;
    }
    // Edit failed (message deleted?), fall through to send new
  }

  const msgId = await sendTelegramMessageWithId(chatJid, text);
  if (msgId) {
    entry.textMessageId = msgId;
    entry.lastText = text;
  }
}

/**
 * Update or create the in-place CUA screenshot for a group.
 * Edits existing photo if present, otherwise sends a new one.
 */
async function updateCuaScreenshot(
  groupFolder: string,
  chatJid: string,
  hostPath: string,
): Promise<void> {
  let entry = activeCuaLogMessages.get(groupFolder);
  if (!entry) {
    entry = { chatJid, textMessageId: null, screenshotMessageId: null, lastText: '' };
    activeCuaLogMessages.set(groupFolder, entry);
  }

  if (entry.screenshotMessageId) {
    const edited = await editTelegramPhoto(chatJid, entry.screenshotMessageId, hostPath, 'Screenshot');
    if (edited) return;
    // Edit failed, fall through to send new
  }

  const msgId = await sendTelegramPhoto(chatJid, hostPath, 'Screenshot');
  if (msgId) {
    entry.screenshotMessageId = msgId;
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ module: 'index', err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Clean up stale cancel files (older than 30s) to prevent leftover state
      try {
        const cancelFile = path.join(ipcBaseDir, sourceGroup, 'cancel');
        if (fs.existsSync(cancelFile)) {
          const stat = fs.statSync(cancelFile);
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.unlinkSync(cancelFile);
          }
        }
      } catch {}

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(data.chatJid, data.text);
                  logger.info(
                    { module: 'index', chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { module: 'index', chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'voice' &&
                data.chatJid &&
                data.text
              ) {
                // Voice message via Freya TTS
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (isFreyaEnabled()) {
                    try {
                      // Resolve emotion: agent-specified or keyword fallback
                      let emotion;
                      if (data.emotion) {
                        const parsed = parseEmotion(data.emotion);
                        if ('error' in parsed) {
                          logger.warn(
                            { module: 'index', emotion: data.emotion, error: parsed.error },
                            'Invalid emotion from agent, auto-detecting',
                          );
                          emotion = detectEmotionFromText(data.text);
                        } else {
                          emotion = parsed;
                        }
                      } else {
                        emotion = detectEmotionFromText(data.text);
                      }
                      const markedText = formatFreyaText(data.text, emotion);
                      const mediaDir = path.join(
                        GROUPS_DIR,
                        sourceGroup,
                        'media',
                      );
                      const oggPath = await synthesizeSpeech(
                        markedText,
                        mediaDir,
                      );
                      await sendTelegramVoice(data.chatJid, oggPath);
                      logger.info(
                        {
                          module: 'index',
                          chatJid: data.chatJid,
                          sourceGroup,
                          emotion: emotion.name,
                        },
                        'IPC voice message sent',
                      );
                    } catch (err) {
                      logger.error(
                        { module: 'index', err, chatJid: data.chatJid },
                        'TTS failed, falling back to text',
                      );
                      await sendMessage(data.chatJid, data.text);
                    }
                  } else {
                    logger.warn(
                      { module: 'index', sourceGroup },
                      'send_voice used but FREYA_API_KEY not set, sending as text',
                    );
                    await sendMessage(data.chatJid, data.text);
                  }
                } else {
                  logger.warn(
                    { module: 'index', chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice message attempt blocked',
                  );
                }
              } else if (
                data.type === 'file' &&
                data.chatJid &&
                data.filePath
              ) {
                // File/document message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Translate container path to host path
                  const containerPath = String(data.filePath);
                  let hostFilePath: string;
                  if (containerPath.startsWith('/workspace/group/')) {
                    hostFilePath = path.join(
                      GROUPS_DIR,
                      sourceGroup,
                      containerPath.slice('/workspace/group/'.length),
                    );
                  } else if (containerPath.startsWith('/workspace/global/')) {
                    hostFilePath = path.join(
                      GROUPS_DIR,
                      'global',
                      containerPath.slice('/workspace/global/'.length),
                    );
                  } else {
                    logger.warn(
                      { module: 'index', containerPath, sourceGroup },
                      'IPC file path must start with /workspace/group/ or /workspace/global/',
                    );
                    hostFilePath = '';
                  }

                  if (hostFilePath && fs.existsSync(hostFilePath)) {
                    try {
                      await sendTelegramDocument(
                        data.chatJid,
                        hostFilePath,
                        data.caption || undefined,
                      );
                      logger.info(
                        {
                          module: 'index',
                          chatJid: data.chatJid,
                          sourceGroup,
                          file: hostFilePath,
                        },
                        'IPC file message sent',
                      );
                    } catch (err) {
                      logger.error(
                        { module: 'index', err, chatJid: data.chatJid, file: hostFilePath },
                        'Failed to send file via Telegram',
                      );
                    }
                  } else {
                    logger.warn(
                      { module: 'index', containerPath, hostFilePath, sourceGroup },
                      'IPC file not found on host',
                    );
                  }
                } else {
                  logger.warn(
                    { module: 'index', chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { module: 'index', file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { module: 'index', err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { module: 'index', file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ module: 'index', err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process browse requests from this group's IPC directory
      const browseDir = path.join(ipcBaseDir, sourceGroup, 'browse');
      try {
        if (fs.existsSync(browseDir)) {
          const reqFiles = fs
            .readdirSync(browseDir)
            .filter((f) => f.startsWith('req-') && f.endsWith('.json'));
          for (const file of reqFiles) {
            const filePath = path.join(browseDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const { id: requestId, action, params } = data;
              const browseParams = (params || {}) as Record<string, unknown>;
              const chatJid = getChatJidForGroup(sourceGroup);

              // For wait_for_user, send takeover details first.
              if (action === 'wait_for_user') {
                const waitMessage =
                  typeof browseParams.message === 'string' &&
                  browseParams.message.trim().length > 0
                    ? browseParams.message.trim()
                    : 'Please take over the CUA browser session, then return control when done.';

                // Ensure sandbox is running so the user gets a usable live URL.
                try {
                  await ensureSandbox();
                } catch (err) {
                  logger.warn(
                    { module: 'index', err, sourceGroup },
                    'Failed to prestart sandbox for wait_for_user',
                  );
                }

                const waitRequest = ensureWaitForUserRequest(
                  requestId,
                  sourceGroup,
                  waitMessage,
                );

                if (chatJid) {
                  const ownerSession = createSessionForOwner();
                  const takeoverUrl = getTakeoverUrl(waitRequest.token, ownerSession?.token);
                  const takeoverPart = takeoverUrl
                    ? `\nTake over CUA: ${takeoverUrl}`
                    : '';
                  await sendMessage(
                    chatJid,
                    `${waitMessage}${takeoverPart}\nRequest ID: ${requestId}\n\nWhen done, click "Return Control To Agent" in the takeover page.\nFallback: reply "continue ${requestId}".`,
                  );
                }
              } else {
                const startNote = describeCuaActionStart(action, browseParams);

                // Emit activity event for follow page
                emitCuaActivity({
                  groupFolder: sourceGroup,
                  action,
                  phase: 'start',
                  description: startNote || action,
                  requestId,
                  params: browseParams,
                });

                // Update CUA log message in-place
                if (chatJid && startNote) {
                  await updateCuaLogMessage(sourceGroup, chatJid, `CUA: ${startNote}`);
                }
              }

              // Process the browse request (may be async for wait_for_user)
              const browseStartMs = Date.now();
              const result = await processBrowseRequest(
                requestId,
                action,
                browseParams,
                sourceGroup,
                browseDir,
              );
              const browseDurationMs = Date.now() - browseStartMs;
              const usage = updateCuaUsage(sourceGroup, action, result.status);

              // Emit activity end event for follow page
              if (action !== 'wait_for_user') {
                emitCuaActivity({
                  groupFolder: sourceGroup,
                  action,
                  phase: 'end',
                  description: describeCuaActionStart(action, browseParams) || action,
                  requestId,
                  status: result.status,
                  durationMs: browseDurationMs,
                  error: result.status === 'error' ? String(result.error || 'unknown') : undefined,
                  screenshotPath: action === 'screenshot' && result.status === 'ok' ? (result.result as string) : undefined,
                  usage: { total: usage.total, ok: usage.ok, failed: usage.failed },
                });
              }

              if (chatJid && action !== 'wait_for_user') {
                const statusText =
                  result.status === 'ok'
                    ? 'ok'
                    : `error: ${truncateForTelegram(String(result.error || 'unknown'), 140)}`;
                await updateCuaLogMessage(
                  sourceGroup,
                  chatJid,
                  `CUA ${action}: ${statusText} (${browseDurationMs}ms) | ${usage.ok}/${usage.total} actions`,
                );
              }

              // Write response file (atomic: temp + rename)
              const resFile = path.join(browseDir, `res-${requestId}.json`);
              const tmpFile = `${resFile}.tmp`;
              fs.writeFileSync(tmpFile, JSON.stringify(result));
              fs.renameSync(tmpFile, resFile);

              // Clean up request file
              fs.unlinkSync(filePath);

              // Update screenshot photo in-place
              if (
                action === 'screenshot' &&
                result.status === 'ok' &&
                result.result
              ) {
                if (chatJid) {
                  // Translate container path back to host path
                  const containerPath = result.result as string;
                  const hostPath = path.join(
                    GROUPS_DIR,
                    sourceGroup,
                    'media',
                    path.basename(containerPath),
                  );
                  try {
                    await updateCuaScreenshot(sourceGroup, chatJid, hostPath);
                  } catch (photoErr) {
                    logger.warn(
                      { module: 'index', photoErr, hostPath },
                      'Failed to send/edit screenshot as Telegram photo',
                    );
                  }
                }
              }

              logger.debug(
                { module: 'index', requestId, action, sourceGroup, status: result.status },
                'Browse request processed',
              );
            } catch (err) {
              logger.error(
                { module: 'index', file, sourceGroup, err },
                'Error processing browse request',
              );
              // Write error response so agent doesn't hang
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                const resFile = path.join(browseDir, `res-${data.id}.json`);
                const tmpFile = `${resFile}.tmp`;
                fs.writeFileSync(
                  tmpFile,
                  JSON.stringify({
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
                fs.renameSync(tmpFile, resFile);
              } catch {
                // Can't even write error response
              }
              try {
                fs.unlinkSync(filePath);
              } catch {
                // Already cleaned up
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { module: 'index', err, sourceGroup },
          'Error reading IPC browse directory',
        );
      }

      // Process status events from this group's IPC directory
      const statusDir = path.join(ipcBaseDir, sourceGroup, 'status');
      try {
        if (fs.existsSync(statusDir)) {
          const statusFiles = fs
            .readdirSync(statusDir)
            .filter((f) => f.startsWith('evt-') && f.endsWith('.json'))
            .sort();

          if (statusFiles.length > 0) {
            // Always collect all events and clean up files
            const events: Array<Record<string, unknown>> = [];
            for (const file of statusFiles) {
              const filePath = path.join(statusDir, file);
              try {
                events.push(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
              } catch {}
              try {
                fs.unlinkSync(filePath);
              } catch {}
            }

            // Always log adapter_stderr events to Pino
            for (const evt of events) {
              if (evt.type === 'adapter_stderr') {
                logger.warn(
                  { module: 'claude-cli', group_folder: sourceGroup },
                  `[stderr] ${evt.message}`,
                );
              }
            }

            // Update the editable thinking status message (always-on when active)
            const statusEntry = activeStatusMessages.get(sourceGroup);
            if (statusEntry && events.length > 0) {
              // Priority: thinking content > tool name
              const lastThinking = [...events].reverse().find(e => e.type === 'thinking');
              const lastToolStart = [...events].reverse().find(e => e.type === 'tool_start');

              let newText: string | undefined;
              if (lastThinking) {
                newText = String(lastThinking.content);
              } else if (lastToolStart) {
                const toolName = String(lastToolStart.tool_name || '').replace(/^mcp__nanoclaw__/, '');
                if (!HIDDEN_TOOLS.has(toolName)) {
                  newText = humanizeToolName(String(lastToolStart.tool_name));
                }
              }

              if (newText && newText !== statusEntry.currentText) {
                const now = Date.now();
                if (now - statusEntry.lastEditTime >= STATUS_EDIT_INTERVAL_MS) {
                  // Telegram allows ~4096 chars per message; account for <i></i> tags
                  const MAX_CHUNK = 4000;

                  // Delete any previous overflow messages before sending new ones
                  for (const extraId of statusEntry.extraMessageIds) {
                    await deleteTelegramMessage(statusEntry.chatJid, extraId);
                  }
                  statusEntry.extraMessageIds = [];

                  // Split into chunks at line boundaries when possible
                  const chunks: string[] = [];
                  let remaining = newText;
                  while (remaining.length > 0) {
                    if (remaining.length <= MAX_CHUNK) {
                      chunks.push(remaining);
                      break;
                    }
                    // Try to split at a newline within the chunk
                    let splitAt = remaining.lastIndexOf('\n', MAX_CHUNK);
                    if (splitAt === -1) splitAt = MAX_CHUNK;
                    chunks.push(remaining.slice(0, splitAt));
                    remaining = remaining.slice(splitAt).replace(/^\n/, '');
                  }

                  // Edit the primary message with the first chunk
                  const edited = await editTelegramStatusMessage(
                    statusEntry.chatJid,
                    statusEntry.messageId,
                    chunks[0],
                  );
                  if (edited) {
                    statusEntry.currentText = newText;
                    statusEntry.lastEditTime = now;

                    // Send overflow chunks as additional messages
                    for (let i = 1; i < chunks.length; i++) {
                      const extraId = await sendTelegramStatusMessage(
                        statusEntry.chatJid,
                        chunks[i],
                      );
                      if (extraId) {
                        statusEntry.extraMessageIds.push(extraId);
                      }
                    }
                  }
                }
              }
            }

            // Verbose mode: still send full detail messages
            const chatJid = Object.entries(registeredGroups).find(
              ([, g]) => g.folder === sourceGroup,
            )?.[0];

            if (chatJid && isVerbose(chatJid) && events.length > 0) {
              const lines: string[] = [];
              for (const evt of events) {
                if (evt.type === 'tool_start') {
                  const preview = evt.preview
                    ? String(evt.preview).slice(0, 100)
                    : '';
                  lines.push(
                    `> ${evt.tool_name}${preview ? ': ' + preview : ''}`,
                  );
                } else if (evt.type === 'tool_progress') {
                  lines.push(`> ${evt.tool_name} (${evt.elapsed_seconds}s)`);
                }
              }
              if (lines.length > 0) {
                const statusMsg = lines.slice(0, 5).join('\n');
                try {
                  await sendTelegramMessage(chatJid, statusMsg);
                } catch (err) {
                  logger.debug({ module: 'index', err }, 'Failed to send verbose status message');
                }
              }
            }
          }
        }
      } catch (err) {
        logger.debug(
          { module: 'index', err, sourceGroup },
          'Error reading IPC status directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info({ module: 'index' }, 'IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    providerConfig?: RegisteredGroup['providerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { module: 'index', sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { module: 'index', targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { module: 'index', scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { module: 'index', scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { module: 'index', scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { module: 'index', taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { module: 'index', taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { module: 'index', sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          providerConfig: data.providerConfig,
        });
      } else {
        logger.warn(
          { module: 'index', data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'skill_changed': {
      // Re-register Telegram commands for the affected group's chat
      const chatJidForSkill = getChatJidForGroup(sourceGroup);
      if (chatJidForSkill) {
        try {
          const { refreshSkillCommands } = await import('./telegram.js');
          await refreshSkillCommands(chatJidForSkill, sourceGroup);
          logger.info(
            { module: 'index', sourceGroup, action: (data as { action?: string }).action, skill: (data as { skillName?: string }).skillName },
            'Skill changed, Telegram commands refreshed',
          );
        } catch (err) {
          logger.error({ module: 'index', err }, 'Failed to refresh skill commands');
        }
      }
      break;
    }

    default:
      logger.warn({ module: 'index', type: data.type }, 'Unknown IPC task type');
  }
}

async function startMessageLoop(): Promise<void> {
  logger.info({ module: 'index' }, `NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ module: 'index', count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { module: 'index', err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ module: 'index', err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug({ module: 'index' }, 'Docker is running');
  } catch {
    logger.error({ module: 'index' }, 'Docker is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Install Docker: https://docs.docker.com/get-docker/      ║',
    );
    console.error(
      '║  2. Start Docker: sudo systemctl start docker                 ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }
}

function ensureDockerImageRequirements(): void {
  if (CUA_SANDBOX_IMAGE_IS_LEGACY) {
    logger.warn(
      {
        module: 'index',
        configuredImage: 'trycua/cua-sandbox:latest',
        effectiveImage: CUA_SANDBOX_IMAGE,
      },
      'CUA_SANDBOX_IMAGE uses deprecated image name; falling back to trycua/cua-xfce:latest',
    );
  }

  try {
    execSync(`docker image inspect ${CONTAINER_IMAGE}`, { stdio: 'pipe' });
    logger.debug({ module: 'index', image: CONTAINER_IMAGE }, 'Agent image is available');
  } catch {
    logger.error(
      { module: 'index', image: CONTAINER_IMAGE },
      'Agent Docker image is missing. Build it with ./container/build.sh',
    );
    throw new Error(`Missing Docker image: ${CONTAINER_IMAGE}`);
  }

  try {
    execSync(`docker image inspect ${CUA_SANDBOX_IMAGE}`, { stdio: 'pipe' });
    logger.debug(
      { module: 'index', image: CUA_SANDBOX_IMAGE },
      'CUA sandbox image is available',
    );
  } catch {
    logger.info(
      { module: 'index', image: CUA_SANDBOX_IMAGE, platform: CUA_SANDBOX_PLATFORM },
      'CUA sandbox image missing, pulling now',
    );
    try {
      execSync(
        `docker pull --platform ${CUA_SANDBOX_PLATFORM} ${CUA_SANDBOX_IMAGE}`,
        { stdio: 'pipe' },
      );
      logger.info(
        { module: 'index', image: CUA_SANDBOX_IMAGE, platform: CUA_SANDBOX_PLATFORM },
        'CUA sandbox image pulled',
      );
    } catch (pullErr) {
      logger.error(
        {
          module: 'index',
          image: CUA_SANDBOX_IMAGE,
          platform: CUA_SANDBOX_PLATFORM,
          err: pullErr,
        },
        'Failed to pull CUA sandbox image',
      );
      throw new Error(`Failed to pull Docker image: ${CUA_SANDBOX_IMAGE}`);
    }
  }
}

async function main(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error({ module: 'index' }, 'TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }
  if (!TELEGRAM_OWNER_ID) {
    logger.error({ module: 'index' }, 'TELEGRAM_OWNER_ID is required');
    process.exit(1);
  }
  ensureContainerSystemRunning();
  ensureDockerImageRequirements();
  cleanupOrphanPersistentContainers();
  initDatabase();
  logger.info({ module: 'index' }, 'Database initialized');
  initTrajectoryPersistence();
  initLogSync();
  pruneOldLogEntries();
  loadState();
  // Clean up old media files on startup (7 day retention)
  for (const group of Object.values(registeredGroups)) {
    cleanupOldMedia(path.join(GROUPS_DIR, group.folder, 'media'), 7);
  }

  const sessionManager: SessionManager = {
    getSession(chatJid: string): string | undefined {
      const group = registeredGroups[chatJid];
      if (!group) return undefined;
      return sessions[group.folder];
    },
    clearSession(chatJid: string): void {
      const group = registeredGroups[chatJid];
      if (group && sessions[group.folder]) {
        delete sessions[group.folder];
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
      }
    },
  };

  const schedulerDeps = {
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  };

  const taskActions: TaskActionHandler = {
    runTaskNow: (taskId: string) => runTaskNow(taskId, schedulerDeps),
  };

  startCuaTakeoverServer();
  startDashboardServer();
  initTailscaleServe();

  const interruptHandler: InterruptHandler = {
    interrupt(chatJid: string) {
      const group = registeredGroups[chatJid];
      if (!group) {
        return { interrupted: false, message: 'No registered group for this chat.' };
      }
      cancelWaitingRequests(group.folder);
      return interruptContainer(group.folder);
    },
  };

  await connectTelegram(
    () => registeredGroups,
    registerGroup,
    sessionManager,
    taskActions,
    interruptHandler,
  );
  startSchedulerLoop(schedulerDeps);
  startIpcWatcher();
  startIdleWatcher();
  startContainerIdleCleanup();
  startMessageLoop();
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ module: 'index', signal }, 'Shutting down');
    stopTelegram();
    killAllContainers();
    await disconnectBrowser();
    stopTailscaleServe();
    stopDashboardServer();
    stopLogSync();
    stopCuaTakeoverServer();
    cleanupSandbox();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ module: 'index', err }, 'Failed to start NanoClaw');
  process.exit(1);
});
