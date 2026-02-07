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
  sendTelegramMessage,
  sendTelegramPhoto,
  setTelegramTyping,
  stopTelegram,
} from './telegram.js';
import type { SessionManager, TaskActionHandler } from './telegram.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import {
  isSupermemoryEnabled,
  retrieveMemories,
  storeInteraction,
  formatMemoryContext,
} from './supermemory.js';
import {
  processBrowseRequest,
  resolveWaitForUser,
  hasWaitingRequests,
  disconnectBrowser,
  ensureWaitForUserRequest,
} from './browse-host.js';
import { cleanupOldMedia } from './media.js';
import {
  cleanupSandbox,
  ensureSandbox,
  startIdleWatcher,
  getSandboxUrl,
} from './sandbox-manager.js';
import {
  getTakeoverUrl,
  startCuaTakeoverServer,
  stopCuaTakeoverServer,
} from './cua-takeover-server.js';

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
    { groupCount: Object.keys(registeredGroups).length },
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
    { jid, name: group.name, folder: group.folder },
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
        { chatJid: msg.chat_jid, groupFolder: group.folder, requestId },
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
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  await setTyping(msg.chat_jid, true);
  const response = await runAgent(group, prompt, msg.chat_jid);
  await setTyping(msg.chat_jid, false);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    let text = response;
    if (DEBUG_THREADS) {
      const threadId = sessions[group.folder];
      if (threadId) {
        text += `\n[thread: ${threadId.slice(0, 8)}]`;
      }
    }
    await sendMessage(msg.chat_jid, text);

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
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(jid, text);
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
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
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

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
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
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
          { err, sourceGroup },
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
                { file, sourceGroup, err },
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
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
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
                    { err, sourceGroup },
                    'Failed to prestart sandbox for wait_for_user',
                  );
                }

                const waitRequest = ensureWaitForUserRequest(
                  requestId,
                  sourceGroup,
                  waitMessage,
                );

                if (chatJid) {
                  const takeoverUrl = getTakeoverUrl(waitRequest.token);
                  const sandboxUrl = getSandboxUrl();
                  const takeoverPart = takeoverUrl
                    ? `\nTake over CUA: ${takeoverUrl}`
                    : '';
                  const urlPart = sandboxUrl
                    ? `\nDirect noVNC: ${sandboxUrl}`
                    : '';
                  await sendMessage(
                    chatJid,
                    `${waitMessage}${takeoverPart}${urlPart}\nRequest ID: ${requestId}\n\nWhen done, click "Return Control To Agent" in the takeover page.\nFallback: reply "continue ${requestId}".`,
                  );
                }
              } else if (chatJid) {
                const startNote = describeCuaActionStart(action, browseParams);
                if (startNote) {
                  await sendMessage(chatJid, `CUA: ${startNote}`);
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

              if (chatJid && action !== 'wait_for_user') {
                const statusText =
                  result.status === 'ok'
                    ? 'ok'
                    : `error: ${truncateForTelegram(String(result.error || 'unknown'), 140)}`;
                const summaryText = `Usage ${usage.total} actions (${usage.ok} ok, ${usage.failed} failed)`;
                const recentText = usage.recent.join(' -> ');
                await sendMessage(
                  chatJid,
                  `CUA ${action}: ${statusText} (${browseDurationMs}ms)\n${summaryText}\nRecent: ${recentText}`,
                );
              }

              // Write response file (atomic: temp + rename)
              const resFile = path.join(browseDir, `res-${requestId}.json`);
              const tmpFile = `${resFile}.tmp`;
              fs.writeFileSync(tmpFile, JSON.stringify(result));
              fs.renameSync(tmpFile, resFile);

              // Clean up request file
              fs.unlinkSync(filePath);

              // Send screenshots as Telegram photos for better UX
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
                    await sendTelegramPhoto(chatJid, hostPath, 'Screenshot');
                  } catch (photoErr) {
                    logger.warn(
                      { photoErr, hostPath },
                      'Failed to send screenshot as Telegram photo',
                    );
                  }
                }
              }

              logger.debug(
                { requestId, action, sourceGroup, status: result.status },
                'Browse request processed',
              );
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
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
          { err, sourceGroup },
          'Error reading IPC browse directory',
        );
      }

      // Process status events from this group's IPC directory (transparency/verbose mode)
      const statusDir = path.join(ipcBaseDir, sourceGroup, 'status');
      try {
        if (fs.existsSync(statusDir)) {
          const statusFiles = fs
            .readdirSync(statusDir)
            .filter((f) => f.startsWith('evt-') && f.endsWith('.json'))
            .sort();

          if (statusFiles.length > 0) {
            // Find the chat JID for this group
            const chatJid = Object.entries(registeredGroups).find(
              ([, g]) => g.folder === sourceGroup,
            )?.[0];

            if (chatJid && isVerbose(chatJid)) {
              // Rate limit: collect all events, send at most 1 summary per poll cycle
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

              if (events.length > 0) {
                // Format status summary
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
                  const statusMsg = lines.slice(0, 5).join('\n'); // Max 5 lines
                  try {
                    await sendTelegramMessage(chatJid, statusMsg);
                  } catch (err) {
                    logger.debug({ err }, 'Failed to send status message');
                  }
                }
              }
            } else {
              // Not verbose - just clean up status files silently
              for (const file of statusFiles) {
                try {
                  fs.unlinkSync(path.join(statusDir, file));
                } catch {}
              }
            }
          }
        }
      } catch (err) {
        logger.debug(
          { err, sourceGroup },
          'Error reading IPC status directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
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
            { sourceGroup, targetGroup },
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
            { targetGroup },
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
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
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
          { taskId, sourceGroup, targetGroup, contextMode },
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
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
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
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
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
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
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
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker is running');
  } catch {
    logger.error('Docker is not running');
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
        configuredImage: 'trycua/cua-sandbox:latest',
        effectiveImage: CUA_SANDBOX_IMAGE,
      },
      'CUA_SANDBOX_IMAGE uses deprecated image name; falling back to trycua/cua-xfce:latest',
    );
  }

  try {
    execSync(`docker image inspect ${CONTAINER_IMAGE}`, { stdio: 'pipe' });
    logger.debug({ image: CONTAINER_IMAGE }, 'Agent image is available');
  } catch {
    logger.error(
      { image: CONTAINER_IMAGE },
      'Agent Docker image is missing. Build it with ./container/build.sh',
    );
    throw new Error(`Missing Docker image: ${CONTAINER_IMAGE}`);
  }

  try {
    execSync(`docker image inspect ${CUA_SANDBOX_IMAGE}`, { stdio: 'pipe' });
    logger.debug(
      { image: CUA_SANDBOX_IMAGE },
      'CUA sandbox image is available',
    );
  } catch {
    logger.info(
      { image: CUA_SANDBOX_IMAGE, platform: CUA_SANDBOX_PLATFORM },
      'CUA sandbox image missing, pulling now',
    );
    try {
      execSync(
        `docker pull --platform ${CUA_SANDBOX_PLATFORM} ${CUA_SANDBOX_IMAGE}`,
        { stdio: 'pipe' },
      );
      logger.info(
        { image: CUA_SANDBOX_IMAGE, platform: CUA_SANDBOX_PLATFORM },
        'CUA sandbox image pulled',
      );
    } catch (pullErr) {
      logger.error(
        {
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
    logger.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }
  if (!TELEGRAM_OWNER_ID) {
    logger.error('TELEGRAM_OWNER_ID is required');
    process.exit(1);
  }
  ensureContainerSystemRunning();
  ensureDockerImageRequirements();
  cleanupOrphanPersistentContainers();
  initDatabase();
  logger.info('Database initialized');
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

  await connectTelegram(
    () => registeredGroups,
    registerGroup,
    sessionManager,
    taskActions,
  );
  startSchedulerLoop(schedulerDeps);
  startCuaTakeoverServer();
  startIpcWatcher();
  startIdleWatcher();
  startContainerIdleCleanup();
  startMessageLoop();
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    stopTelegram();
    killAllContainers();
    await disconnectBrowser();
    stopCuaTakeoverServer();
    cleanupSandbox();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
