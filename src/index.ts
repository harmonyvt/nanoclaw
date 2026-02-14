import { execSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CUA_SANDBOX_IMAGE,
  CUA_SANDBOX_IMAGE_IS_LEGACY,
  CUA_SANDBOX_PLATFORM,
  DATA_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  TIMEZONE,
  TRIGGER_PATTERN,
  MAX_AGENT_RETRIES,
  AGENT_RETRY_DELAY,
  QWEN_TTS_ENABLED,
  QWEN_TTS_URL,
} from './config.js';
import {
  AvailableGroup,
  cleanupOrphanPersistentContainers,
  consumeGroupInterrupted,
  ensureAgentImage,
  HostRpcEvent,
  HostRpcRequest,
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
  getConversationHistory,
  getNewMessages,
  initDatabase,
  storeAssistantMessage,
} from './db.js';
import { runTaskNow, startSchedulerLoop } from './task-scheduler.js';
import {
  connectTelegram,
  isVerbose,
  isThinkingEnabled,
  addThinkingDisabled,
  removeThinkingDisabled,
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
import type { OnMessageStored, TaskActionHandler, InterruptHandler } from './telegram.js';
import { NewMessage, RegisteredGroup } from './types.js';
import {
  detectEmotionFromText,
  formatFreyaText,
  isFreyaEnabled,
  looksLikeCode,
  parseEmotion,
  synthesizeSpeech,
} from './tts.js';
import {
  isTTSEnabled,
  loadUnifiedVoiceProfile,
  defaultUnifiedVoiceProfile,
  synthesizeTTS,
} from './tts-dispatch.js';
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
  routeHostRpcEvent,
  routeHostRpcRequest,
} from './host-rpc-router.js';
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
import { agentSemaphore } from './concurrency.js';
import { MAX_CONVERSATION_MESSAGES } from './config.js';
import { logDebugEvent, exportDebugReport, pruneDebugEventEntries } from './debug-log.js';
import { hasSoulConfigured, resolveAssistantIdentity } from './soul.js';

let lastTimestamp = '';
let registeredGroups: Record<string, RegisteredGroup> = {};
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
  hadThinkingContent: boolean;
}

/** Active italic status messages keyed by group folder */
const activeStatusMessages = new Map<string, ActiveStatusMessage>();

// ─── Response Streaming Message Tracking ─────────────────────────────────────

interface ActiveStreamingMessage {
  chatJid: string;
  messageId: number;
  currentText: string;
  lastEditTime: number;
}

/** Active streaming response messages keyed by group folder (plain text, edit-in-place) */
const activeStreamingMessages = new Map<string, ActiveStreamingMessage>();

async function cleanupStreamingMessage(groupFolder: string): Promise<void> {
  const entry = activeStreamingMessages.get(groupFolder);
  if (entry) {
    activeStreamingMessages.delete(groupFolder);
    await deleteTelegramMessage(entry.chatJid, entry.messageId);
  }
}

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

const VOICE_DEDUPE_WINDOW_MS = 2500;
const lastVoiceSentAtByChat = new Map<string, number>();

function shouldSuppressDuplicateVoice(chatJid: string): boolean {
  const now = Date.now();
  const last = lastVoiceSentAtByChat.get(chatJid);
  if (typeof last === 'number' && now - last < VOICE_DEDUPE_WINDOW_MS) {
    return true;
  }
  lastVoiceSentAtByChat.set(chatJid, now);
  return false;
}

function humanizeToolName(rawName: string): string {
  const name = rawName.replace(/^mcp__nanoclaw__/, '');
  return TOOL_DISPLAY_NAMES[name] || name.replace(/_/g, ' ');
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (isTyping) await setTelegramTyping(jid);
}

// ─── Conversation History Helper ─────────────────────────────────────────────

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Build the <messages> XML block from DB conversation history.
 * Returns { messagesXml, latestContent } for use in prompts and memory retrieval.
 */
function buildConversationXml(chatJid: string, groupFolder: string): {
  messagesXml: string;
  latestContent: string;
  messageCount: number;
} {
  const history = getConversationHistory(chatJid, MAX_CONVERSATION_MESSAGES);

  const lines = history.map((m) => {
    let mediaAttrs = '';
    if (m.media_type && m.media_path) {
      const groupDir = path.join(GROUPS_DIR, groupFolder);
      const containerPath = m.media_path.startsWith(groupDir)
        ? '/workspace/group' + m.media_path.slice(groupDir.length)
        : m.media_path;
      mediaAttrs = ` media_type="${escapeXml(m.media_type)}" media_path="${escapeXml(containerPath)}"`;
    }
    return `<message role="${m.role}" sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttrs}>${escapeXml(m.content)}</message>`;
  });

  return {
    messagesXml: `<messages>\n${lines.join('\n')}\n</messages>`,
    latestContent: history[history.length - 1]?.content || '',
    messageCount: history.length,
  };
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );

  // Load persisted thinking state from .thinking_disabled files
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (fs.existsSync(path.join(GROUPS_DIR, group.folder, '.thinking_disabled'))) {
      addThinkingDisabled(chatJid);
    }
  }

  logger.info(
    { module: 'index', groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
  });
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
  const getAssistantIdentity = () =>
    resolveAssistantIdentity(group.folder, ASSISTANT_NAME);
  const ensureSoulReady = async (): Promise<boolean> => {
    if (hasSoulConfigured(group.folder)) return true;
    await sendMessage(
      msg.chat_jid,
      'I need a persona before I can respond. Please run /soul to set it up (try /soul reset), then send your request again.',
    );
    logDebugEvent('telegram', 'command_invoked', group.folder, {
      command: 'soul_required',
    });
    return false;
  };

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  logDebugEvent('telegram', 'message_received', group.folder, {
    chatJid: msg.chat_jid,
    contentLength: content.length,
    hasMedia: !!(msg.media_type),
    mediaType: msg.media_type || null,
    senderName: msg.sender_name,
  });

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

  // Handle /mute toggle (host-level, no agent needed)
  if (/^\/mute$/i.test(content)) {
    const mutePath = path.join(GROUPS_DIR, group.folder, '.tts_muted');
    const wasMuted = fs.existsSync(mutePath);
    if (wasMuted) {
      fs.unlinkSync(mutePath);
      await sendMessage(msg.chat_jid, 'TTS unmuted — voice messages enabled.');
    } else {
      fs.writeFileSync(mutePath, '');
      await sendMessage(msg.chat_jid, 'TTS muted — text only.');
    }
    logDebugEvent('telegram', 'command_invoked', group.folder, { command: 'mute', wasMuted });
    return;
  }

  // Handle /debug — export debug event log (host-level, no agent needed)
  const debugMatch = content.match(/^\/debug(?:\s+(.*))?$/i);
  if (debugMatch) {
    const params = (debugMatch[1] || '').trim();

    let since: number | undefined;
    const durationMatch = params.match(/^(\d+)([hdm])$/);
    if (durationMatch) {
      const val = parseInt(durationMatch[1], 10);
      const unit = durationMatch[2];
      const multipliers: Record<string, number> = { h: 3600000, d: 86400000, m: 60000 };
      since = Date.now() - val * multipliers[unit];
    } else if (!params) {
      since = Date.now() - 24 * 60 * 60 * 1000; // Default: last 24h
    }

    const report = exportDebugReport({
      since,
      group: isMainGroup ? undefined : group.folder,
    });
    const reportJson = JSON.stringify(report, null, 2);

    const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const tmpPath = path.join(mediaDir, `debug-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, reportJson);

    try {
      const caption = `Debug events: ${report.stats.total} total, exported ${report.events.length}`;
      await sendTelegramDocument(msg.chat_jid, tmpPath, caption);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    logDebugEvent('telegram', 'command_invoked', group.folder, { command: 'debug', params });
    return;
  }

  // Handle /thinking toggle (host-level, no agent needed)
  if (/^\/thinking$/i.test(content)) {
    const thinkingPath = path.join(GROUPS_DIR, group.folder, '.thinking_disabled');
    const wasDisabled = fs.existsSync(thinkingPath);
    if (wasDisabled) {
      fs.unlinkSync(thinkingPath);
      removeThinkingDisabled(msg.chat_jid);
      await sendMessage(msg.chat_jid, 'Extended thinking enabled — reasoning will be shown.');
    } else {
      fs.writeFileSync(thinkingPath, '');
      addThinkingDisabled(msg.chat_jid);
      await sendMessage(msg.chat_jid, 'Extended thinking disabled — faster responses.');
    }
    return;
  }

  // Handle /voice — unified TTS voice configuration (design, preset, clone, reset)
  const voiceMatch = content.match(/^\/voice(?:\s+(.*))?$/i);
  if (voiceMatch) {
    if (!(await ensureSoulReady())) return;
    const params = voiceMatch[1] || '';
    const instructions = `Help the user configure the TTS voice for this chat.

First, read /workspace/group/voice_profile.json to show current settings (if it exists).

Options:

0. **Switch TTS provider** — Ask the user which provider to use. Show the capabilities of each:

   | Provider | Modes | Languages |
   |----------|-------|-----------|
   | qwen3-tts (self-hosted) | custom_voice, voice_design, voice_clone | 10 |
   | qwen/qwen3-tts (Replicate) | custom_voice, voice_design, voice_clone | 10 |
   | resemble-ai/chatterbox-turbo (Replicate) | custom_voice, voice_clone | English only |
   | minimax/speech-2.8-turbo (Replicate) | custom_voice only | 40+ |

   Replicate providers require REPLICATE_TTS_ENABLED=true and a Replicate API token.

1. **Design a voice from description** (qwen3-tts and qwen/qwen3-tts only) — Ask the user to describe how they want the voice to sound. Examples: 'a warm, confident female voice with a slight British accent, mid-30s', 'a deep, calm male voice, authoritative but friendly'. Write voice_profile.json with mode: voice_design.

2. **Use a preset voice** — Show the available preset voices for the selected provider:

   **qwen3-tts / qwen/qwen3-tts presets:**
   - Vivian (female, warm), Serena (female, elegant), Dylan (male, casual)
   - Eric (male, authoritative), Ryan (male, friendly), Aiden (male, young)
   - Uncle_Fu (male, mature), Ono_Anna (female, Japanese), Sohee (female, Korean)
   Optional 'instruct' field for style direction (e.g. "speak cheerfully").

   **resemble-ai/chatterbox-turbo presets:**
   - Andy, Abigail, Aaron, Brian, Chloe, Dylan
   Optional extras: temperature (0.05-2.0), exaggeration (0.25-2.0), cfg_weight (0.0-1.0)

   **minimax/speech-2.8-turbo presets:**
   - Wise_Woman, Friendly_Person, Deep_Voice_Man, Calm_Woman, Casual_Guy
   - Lively_Girl, Patient_Man, Young_Knight, Determined_Man, Lovely_Girl
   - Decent_Boy, Inspirational_Girl, Imposing_Manner, Elegant_Man, Abbess
   - Sweet_Girl_2, Exuberant_Girl
   Optional extras: speed (0.5-2.0), pitch (-12 to 12), emotion (happy/sad/angry/calm/etc.)

   Write voice_profile.json with mode: custom_voice.

3. **Clone a voice from audio** (qwen3-tts, qwen/qwen3-tts, resemble-ai/chatterbox-turbo) — The user provides an audio source:

   **Downloading from URLs:**
   Use the download_audio tool directly — it uses yt-dlp and supports YouTube, Twitch, SoundCloud, and hundreds of other platforms:
     download_audio({ url: "https://...", filename: "ref_voice_raw" })

   **Other sources (non-URL):**
   a. **Telegram attachment** — Check recent messages for media files in /workspace/group/media/
   b. **Direct file path** — Use as-is

   Process the audio to proper format (24kHz mono WAV, max 10 seconds) using the convert_audio tool:
     convert_audio({ input_path: "/workspace/group/media/ref_voice_raw.wav", output_path: "/workspace/group/media/voice_ref.wav", sample_rate: 24000, mono: true, max_duration: 10 })

   Get a transcript: use the transcribe_audio tool on the processed WAV file (needed for qwen providers, optional for chatterbox).
   If transcribe_audio fails (no API key), ask the user for the transcript or leave ref_text empty (lower quality clone).

   Write voice_profile.json with mode: voice_clone.

4. **Reset to default** — Delete /workspace/group/voice_profile.json.

After any voice change, send a test voice message using send_voice with a short greeting so the user can hear the result.

Voice profile JSON format (include only the active mode's config, not all):

For qwen3-tts (self-hosted) or qwen/qwen3-tts (Replicate):
{
  "provider": "qwen3-tts" or "qwen/qwen3-tts",
  "mode": "voice_design" or "custom_voice" or "voice_clone",
  "voice_design": { "description": "...", "language": "English" },
  "custom_voice": { "speaker": "...", "instruct": "...", "language": "English" },
  "voice_clone": { "ref_audio_path": "media/voice_ref.wav", "ref_text": "transcript or empty", "language": "English" },
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>"
}

For resemble-ai/chatterbox-turbo:
{
  "provider": "resemble-ai/chatterbox-turbo",
  "mode": "custom_voice" or "voice_clone",
  "custom_voice": { "speaker": "Andy" },
  "voice_clone": { "ref_audio_path": "media/voice_ref.wav" },
  "extras": { "temperature": 0.7, "exaggeration": 0.5 },
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>"
}

For minimax/speech-2.8-turbo:
{
  "provider": "minimax/speech-2.8-turbo",
  "mode": "custom_voice",
  "custom_voice": { "speaker": "Friendly_Person", "language": "English" },
  "extras": { "speed": 1.0, "emotion": "neutral" },
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>"
}`;

    let skillXml = `<skill name="voice"`;
    if (params) skillXml += ` parameters="${escapeXml(params)}"`;
    skillXml += `>\n${escapeXml(instructions)}\n</skill>`;

    const { messagesXml, latestContent } = buildConversationXml(msg.chat_jid, group.folder);

    let memoryXml = '';
    if (isSupermemoryEnabled()) {
      const memories = await retrieveMemories(group.folder, latestContent);
      if (memories) memoryXml = formatMemoryContext(memories);
    }

    const prompt = [memoryXml, skillXml, messagesXml].filter(Boolean).join('\n\n');

    await setTyping(msg.chat_jid, true);
    const response = await runAgent(group, prompt, msg.chat_jid, { isSkillInvocation: true });
    await setTyping(msg.chat_jid, false);
    await cleanupStreamingMessage(group.folder);

    if (response) {
      storeAssistantMessage(
        msg.chat_jid,
        response,
        new Date().toISOString(),
        getAssistantIdentity(),
      );
      const voiceSep = '---voice---';
      const sepIdx = response.indexOf(voiceSep);
      const cleanText = sepIdx !== -1 ? response.replace(voiceSep, '').trim() : response;
      if (cleanText && !cleanText.startsWith('[') && !cleanText.endsWith('queued')) {
        await sendMessage(msg.chat_jid, cleanText);
      }
    }
    return;
  }

  // Handle /soul — manage SOUL.md identity/personality coherently
  const soulMatch = content.match(/^\/soul(?:\s+([\s\S]*))?$/i);
  if (soulMatch) {
    const params = (soulMatch[1] || '').trim();
    const instructions = `Help the user manage SOUL.md (assistant identity/personality) for this chat.

Files:
- /workspace/group/SOUL.md
- /workspace/group/voice_profile.json (optional, for voice coherence)

Behavior:

1) If parameters are empty OR "show":
- Read SOUL.md and summarize current name and personality.
- If SOUL.md does not exist, say so and offer to create one.
- Do not modify files.

2) If parameters are "reset":
- Rewrite SOUL.md to a neutral, helpful assistant persona.
- Use clear markdown sections:
  - H1 assistant name
  - short description
  - Personality
  - Response Style
- Confirm the resulting identity.

3) Otherwise:
- Treat parameters as requested SOUL.md edits.
- Update SOUL.md accordingly.
- Preserve useful existing details unless user asked to remove them.
- Keep the first markdown heading as the assistant name (e.g. "# Yoona").
- If name changes, explicitly confirm the new name.

After any SOUL.md modification:
- Summarize what changed.
- Mention the user can run /voice to align TTS voice with the updated persona.`;

    let skillXml = '<skill name="soul"';
    if (params) skillXml += ` parameters="${escapeXml(params)}"`;
    skillXml += `>\n${escapeXml(instructions)}\n</skill>`;

    const { messagesXml, latestContent } = buildConversationXml(msg.chat_jid, group.folder);

    let memoryXml = '';
    if (isSupermemoryEnabled()) {
      const memories = await retrieveMemories(group.folder, latestContent);
      if (memories) memoryXml = formatMemoryContext(memories);
    }

    const prompt = [memoryXml, skillXml, messagesXml].filter(Boolean).join('\n\n');

    await setTyping(msg.chat_jid, true);
    const response = await runAgent(group, prompt, msg.chat_jid, { isSkillInvocation: true });
    await setTyping(msg.chat_jid, false);
    await cleanupStreamingMessage(group.folder);

    if (response) {
      storeAssistantMessage(
        msg.chat_jid,
        response,
        new Date().toISOString(),
        getAssistantIdentity(),
      );
      const voiceSep = '---voice---';
      const sepIdx = response.indexOf(voiceSep);
      const cleanText = sepIdx !== -1 ? response.replace(voiceSep, '').trim() : response;
      if (cleanText && !cleanText.startsWith('[') && !cleanText.endsWith('queued')) {
        await sendMessage(msg.chat_jid, cleanText);
      }
    }
    return;
  }

  // For all non-/soul interactions, require SOUL.md to be configured first.
  if (!(await ensureSoulReady())) return;

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
      let skillXml = `<skill name="${skillName}"`;
      if (skillParams) skillXml += ` parameters="${escapeXml(skillParams)}"`;
      if (skill.parameters) skillXml += ` accepts="${escapeXml(skill.parameters)}"`;
      skillXml += `>\n${escapeXml(skill.instructions)}\n</skill>`;

      const { messagesXml, latestContent } = buildConversationXml(msg.chat_jid, group.folder);

      let memoryXml = '';
      if (isSupermemoryEnabled()) {
        const memories = await retrieveMemories(group.folder, latestContent);
        if (memories) memoryXml = formatMemoryContext(memories);
      }

      const prompt = [memoryXml, skillXml, messagesXml].filter(Boolean).join('\n\n');

      await setTyping(msg.chat_jid, true);
      const response = await runAgent(group, prompt, msg.chat_jid, { isSkillInvocation: true });
      await setTyping(msg.chat_jid, false);
      await cleanupStreamingMessage(group.folder);

      if (response) {
        storeAssistantMessage(
          msg.chat_jid,
          response,
          new Date().toISOString(),
          getAssistantIdentity(),
        );

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

  // Build conversation context from DB (single source of truth)
  const { messagesXml, latestContent, messageCount } = buildConversationXml(msg.chat_jid, group.folder);

  // Retrieve relevant memories from Supermemory (non-blocking)
  let memoryXml = '';
  if (isSupermemoryEnabled()) {
    const memories = await retrieveMemories(group.folder, latestContent);
    if (memories) memoryXml = formatMemoryContext(memories);
  }

  const prompt = memoryXml
    ? `${memoryXml}\n${messagesXml}`
    : messagesXml;

  if (!prompt) return;

  logger.info(
    { module: 'index', group: group.name, messageCount },
    'Processing message',
  );

  const agentProvider = group.providerConfig?.provider || DEFAULT_PROVIDER;
  const agentModel = group.providerConfig?.model || DEFAULT_MODEL || undefined;
  logDebugEvent('sdk', 'agent_start', group.folder, {
    provider: agentProvider,
    model: agentModel || null,
    promptLength: prompt.length,
    messageCount,
    isSkillInvocation: false,
  });

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
        hadThinkingContent: false,
      });
    }
  }

  const response = await runAgent(group, prompt, msg.chat_jid);

  logDebugEvent('sdk', 'agent_complete', group.folder, {
    hasResult: !!response,
    responseLength: response?.length || 0,
  });

  await setTyping(msg.chat_jid, false);

  // Clean up the streaming response message (before thinking, before final response)
  await cleanupStreamingMessage(group.folder);

  // Clean up the thinking status message(s)
  const statusEntry = activeStatusMessages.get(group.folder);
  if (statusEntry) {
    activeStatusMessages.delete(group.folder);
    if (statusEntry.hadThinkingContent && isThinkingEnabled(msg.chat_jid)) {
      // Keep reasoning visible — don't delete
    } else {
      await deleteTelegramMessage(statusEntry.chatJid, statusEntry.messageId);
      for (const extraId of statusEntry.extraMessageIds) {
        await deleteTelegramMessage(statusEntry.chatJid, extraId);
      }
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
    // Store assistant response in DB (single source of truth for conversation history)
    storeAssistantMessage(
      msg.chat_jid,
      response,
      new Date().toISOString(),
      getAssistantIdentity(),
    );

    const text = response;

    // Auto-TTS: voice-first with text transcription
    // Mute state: groups/{folder}/.tts_muted file presence = muted (default: not muted)
    const isMuted = fs.existsSync(path.join(GROUPS_DIR, group.folder, '.tts_muted'));
    const voiceSep = '---voice---';
    const sepIndex = text.indexOf(voiceSep);

    // Check if any TTS provider is enabled and not muted
    // Falls back to default voice profile when no voice_profile.json exists
    const unifiedProfile = isTTSEnabled()
      ? (loadUnifiedVoiceProfile(group.folder) ?? defaultUnifiedVoiceProfile())
      : null;
    const ttsEnabled = !isMuted && ((unifiedProfile !== null) || isFreyaEnabled());

    if (ttsEnabled) {
      let voicePart: string;
      let textPart: string;

      if (sepIndex !== -1) {
        // Structured: voice summary + full text transcription
        voicePart = text.slice(0, sepIndex).trim();
        textPart = text.slice(sepIndex + voiceSep.length).trim() || voicePart;
      } else if (!looksLikeCode(text)) {
        // Non-code response: voice it all, transcribe after
        // Truncate voice to 2000 chars (TTS limit), full text always sent
        voicePart = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
        textPart = text;
      } else {
        // Code-heavy: text only (TTS would be useless)
        voicePart = '';
        textPart = text;
      }

      let voiceSent = false;
      if (voicePart) {
        const ttsStatusId = await sendTelegramStatusMessage(msg.chat_jid, 'speaking');
        try {
          const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
          let oggPath: string;

          if (unifiedProfile) {
            // TTS via unified dispatch (self-hosted or Replicate)
            oggPath = await synthesizeTTS(voicePart, unifiedProfile, mediaDir, group.folder);
          } else {
            // Freya TTS (fallback)
            const emotion = detectEmotionFromText(voicePart);
            const markedText = formatFreyaText(voicePart, emotion);
            oggPath = await synthesizeSpeech(markedText, mediaDir);
          }

          if (shouldSuppressDuplicateVoice(msg.chat_jid)) {
            logDebugEvent('tts', 'voice_deduped', group.folder, {
              source: 'auto',
              chatJid: msg.chat_jid,
            });
          } else {
            await sendTelegramVoice(msg.chat_jid, oggPath);
            voiceSent = true;
          }
          logDebugEvent('tts', 'auto_tts_attempt', group.folder, {
            provider: unifiedProfile ? unifiedProfile.provider : 'freya',
            voicePartLength: voicePart.length,
            success: true,
          });
        } catch (err) {
          logger.error({ module: 'index', err }, 'Auto-TTS failed, sending as text');
          logDebugEvent('tts', 'auto_tts_attempt', group.folder, {
            provider: unifiedProfile ? unifiedProfile.provider : 'freya',
            voicePartLength: voicePart.length,
            success: false,
            error: String(err),
          });
        } finally {
          if (ttsStatusId) await deleteTelegramMessage(msg.chat_jid, ttsStatusId);
        }
      }

      // Send text only if voice failed or text has content beyond what was voiced
      if (textPart && (!voiceSent || textPart !== voicePart)) {
        await sendMessage(msg.chat_jid, textPart);
      }
    } else {
      // TTS disabled or muted: strip separator and send as plain text
      const cleanText =
        sepIndex !== -1 ? text.replace(voiceSep, '').trim() : text;
      await sendMessage(msg.chat_jid, cleanText);
    }

    // Store interaction to Supermemory (non-blocking)
    if (isSupermemoryEnabled()) {
      void storeInteraction(group.folder, messagesXml, response, {
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
  const baseUrl = group.providerConfig?.baseUrl || undefined;
  const assistantIdentity = resolveAssistantIdentity(group.folder, ASSISTANT_NAME);

  const input = {
    prompt,
    groupFolder: group.folder,
    chatJid,
    isMain,
    isSkillInvocation: opts?.isSkillInvocation,
    assistantName: assistantIdentity,
    provider,
    model,
    baseUrl,
    enableThinking: isThinkingEnabled(chatJid),
  };

  for (let attempt = 0; attempt <= MAX_AGENT_RETRIES; attempt++) {
    if (attempt > 0) {
      // Check if group was interrupted before retrying
      if (consumeGroupInterrupted(group.folder)) {
        logger.info(
          { module: 'index', group: group.name, attempt },
          'Skipping retry — group was interrupted',
        );
        return null;
      }

      logDebugEvent('sdk', 'agent_retry', group.folder, {
        attempt,
        maxRetries: MAX_AGENT_RETRIES,
      });
      logger.warn(
        { module: 'index', group: group.name, attempt, maxRetries: MAX_AGENT_RETRIES },
        `Retrying agent after error (attempt ${attempt + 1}/${MAX_AGENT_RETRIES + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, AGENT_RETRY_DELAY));
    }

    try {
      const output = await runContainerAgent(group, input, {
        onRequest: (req) => handleContainerRpcRequest(group.folder, req),
        onEvent: (evt) => handleContainerRpcEvent(group.folder, evt),
      });

      logDebugEvent('sdk', 'container_result', group.folder, {
        status: output.status,
        hasResult: !!output.result,
        resultLength: output.result?.length || 0,
        provider,
        model: model || null,
      });


      // Interrupted: stop immediately, don't retry
      if (output.status === 'interrupted') {
        logDebugEvent('sdk', 'agent_interrupted', group.folder, {});
        logger.info(
          { module: 'index', group: group.name },
          'Agent interrupted, skipping retries',
        );
        return null;
      }

      if (output.status === 'error') {
        if (attempt < MAX_AGENT_RETRIES) continue;
        logDebugEvent('sdk', 'agent_error', group.folder, {
          error: output.error,
          attempts: attempt + 1,
        });
        logger.error(
          { module: 'index', group: group.name, error: output.error, attempts: attempt + 1 },
          'Container agent error (retries exhausted)',
        );
        return null;
      }

      return output.result;
    } catch (err) {
      if (attempt < MAX_AGENT_RETRIES) continue;
      logDebugEvent('sdk', 'agent_exception', group.folder, {
        error: String(err),
        attempts: attempt + 1,
      });
      logger.error(
        { module: 'index', group: group.name, err, attempts: attempt + 1 },
        'Agent error (retries exhausted)',
      );
      return null;
    }
  }

  return null; // unreachable: loop always returns, but required by TypeScript
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(jid, text);
    logger.info({ module: 'index', jid, length: text.length }, 'Message sent');
    logDebugEvent('telegram', 'message_sent', null, { chatJid: jid, textLength: text.length });
  } catch (err) {
    logger.error({ module: 'index', jid, err }, 'Failed to send message');
    logDebugEvent('telegram', 'message_send_error', null, { chatJid: jid, error: String(err) });
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
    if (edited) {
      logDebugEvent('telegram', 'screenshot_edited', groupFolder, { chatId: chatJid, messageId: entry.screenshotMessageId });
      return;
    }
    // Edit failed — clear stale ID and fall through to send new
    logDebugEvent('telegram', 'screenshot_edit_failed', groupFolder, { chatId: chatJid, messageId: entry.screenshotMessageId });
    entry.screenshotMessageId = null;
  }

  try {
    const msgId = await sendTelegramPhoto(chatJid, hostPath, 'Screenshot');
    if (msgId) {
      entry.screenshotMessageId = msgId;
    }
  } catch (err) {
    logDebugEvent('telegram', 'screenshot_send_failed', groupFolder, {
      chatId: chatJid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function processStatusEvents(
  sourceGroup: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  if (events.length === 0) return;

  // Always log adapter_stderr events to Pino and debug events
  for (const evt of events) {
    if (evt.type === 'adapter_stderr') {
      logger.warn(
        { module: 'claude-cli', group_folder: sourceGroup },
        `[stderr] ${evt.message}`,
      );
      logDebugEvent('sdk', 'adapter_log', sourceGroup, {
        message: String(evt.message),
      });
    }
    if (evt.type === 'tool_start') {
      logDebugEvent('sdk', 'tool_call', sourceGroup, {
        toolName: evt.tool_name,
        preview: String(evt.preview || '').slice(0, 200),
      });
    }
  }

  // Update the editable thinking status message (always-on when active)
  const statusEntry = activeStatusMessages.get(sourceGroup);
  if (statusEntry && events.length > 0) {
    // Priority: thinking content > tool name
    const lastThinking = [...events].reverse().find((e) => e.type === 'thinking');
    const lastToolStart = [...events].reverse().find((e) => e.type === 'tool_start');

    let newText: string | undefined;
    if (lastThinking) {
      newText = String(lastThinking.content);
      statusEntry.hadThinkingContent = true;
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

  // Update streaming response message (progressive text display)
  const lastResponseDelta = [...events].reverse().find((e) => e.type === 'response_delta');
  if (lastResponseDelta) {
    const content = String(lastResponseDelta.content);
    const responseChatJid = statusEntry?.chatJid ||
      Object.entries(registeredGroups).find(([, g]) => g.folder === sourceGroup)?.[0];

    if (responseChatJid && content) {
      let streamEntry = activeStreamingMessages.get(sourceGroup);
      const now = Date.now();

      if (!streamEntry) {
        // Create the streaming message (plain text, not italic)
        const truncated = content.length > 4000 ? content.slice(-4000) : content;
        const msgId = await sendTelegramMessageWithId(responseChatJid, truncated);
        if (msgId) {
          activeStreamingMessages.set(sourceGroup, {
            chatJid: responseChatJid,
            messageId: msgId,
            currentText: content,
            lastEditTime: now,
          });
        }
      } else if (
        content !== streamEntry.currentText &&
        now - streamEntry.lastEditTime >= STATUS_EDIT_INTERVAL_MS
      ) {
        // Edit the existing streaming message with updated content
        const truncated = content.length > 4000 ? content.slice(-4000) : content;
        const edited = await editTelegramMessageText(
          streamEntry.chatJid,
          streamEntry.messageId,
          truncated,
        );
        if (edited) {
          streamEntry.currentText = content;
          streamEntry.lastEditTime = now;
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

async function handleBrowseRpc(
  sourceGroup: string,
  action: string,
  browseParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chatJid = getChatJidForGroup(sourceGroup);

  if (action === 'wait_for_user') {
    const waitMessage =
      typeof browseParams.message === 'string' &&
      browseParams.message.trim().length > 0
        ? browseParams.message.trim()
        : 'Please take over the CUA browser session, then return control when done.';

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
      const takeoverPart = takeoverUrl ? `Take over CUA: ${takeoverUrl}` : '';
      const promptLines = [
        waitMessage,
        '',
        takeoverPart,
        `When done, send: continue ${waitRequest.requestId}`,
      ];
      await sendMessage(chatJid, promptLines.join('\n'));
    }
  } else {
    const startDescription = describeCuaActionStart(action, browseParams);
    if (startDescription) {
      if (chatJid) {
        await updateCuaLogMessage(sourceGroup, chatJid, `CUA ${action}: ${startDescription}`);
      }
      emitCuaActivity({
        groupFolder: sourceGroup,
        action,
        phase: 'start',
        description: startDescription,
        requestId,
      });
    }
  }

  const browseStartedAt = Date.now();
  const result = await processBrowseRequest(
    requestId,
    action,
    browseParams,
    sourceGroup,
    path.join(DATA_DIR, 'ipc', sourceGroup),
  );
  const browseDurationMs = Date.now() - browseStartedAt;

  const usage = updateCuaUsage(sourceGroup, action, result.status === 'ok' ? 'ok' : 'error');
  logDebugEvent('browse', 'action_complete', sourceGroup, {
    action,
    requestId,
    status: result.status,
    durationMs: browseDurationMs,
    total: usage.total,
    ok: usage.ok,
    failed: usage.failed,
  });

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

  if (
    action === 'screenshot' &&
    result.status === 'ok' &&
    result.result &&
    chatJid
  ) {
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

  return result as Record<string, unknown>;
}

async function handleContainerRpcRequest(
  sourceGroup: string,
  req: HostRpcRequest,
): Promise<unknown> {
  return await routeHostRpcRequest(sourceGroup, req, {
    mainGroupFolder: MAIN_GROUP_FOLDER,
    groupFolderForChatJid: (chatJid) => registeredGroups[chatJid]?.folder,
    sendMessage: async (chatJid, text, rpcSourceGroup) => {
      await sendMessage(chatJid, text);
      logDebugEvent('ipc', 'rpc_message_sent', rpcSourceGroup, { chatJid });
    },
    sendVoice: async ({ chatJid, text, emotion }, rpcSourceGroup) => {
      const rpcVoiceProfile = isTTSEnabled()
        ? (loadUnifiedVoiceProfile(rpcSourceGroup) ?? defaultUnifiedVoiceProfile())
        : null;

      if (rpcVoiceProfile) {
        const ttsStatusId = await sendTelegramStatusMessage(chatJid, 'speaking');
        try {
          const mediaDir = path.join(GROUPS_DIR, rpcSourceGroup, 'media');
          const oggPath = await synthesizeTTS(text, rpcVoiceProfile, mediaDir, rpcSourceGroup);
          if (shouldSuppressDuplicateVoice(chatJid)) {
            logDebugEvent('tts', 'voice_deduped', rpcSourceGroup, {
              source: 'rpc',
              chatJid,
              provider: rpcVoiceProfile.provider,
            });
            return 'Voice suppressed (duplicate within dedupe window).';
          }
          await sendTelegramVoice(chatJid, oggPath);
          logDebugEvent('ipc', 'rpc_voice_sent', rpcSourceGroup, { chatJid, provider: rpcVoiceProfile.provider });
          return `Voice sent (${rpcVoiceProfile.provider}).`;
        } finally {
          if (ttsStatusId) await deleteTelegramMessage(chatJid, ttsStatusId);
        }
      }

      if (isFreyaEnabled()) {
        const ttsStatusId = await sendTelegramStatusMessage(chatJid, 'speaking');
        try {
          const selectedEmotion = emotion
            ? (() => {
                const parsed = parseEmotion(emotion);
                return 'error' in parsed ? detectEmotionFromText(text) : parsed;
              })()
            : detectEmotionFromText(text);
          const markedText = formatFreyaText(text, selectedEmotion);
          const mediaDir = path.join(GROUPS_DIR, rpcSourceGroup, 'media');
          const oggPath = await synthesizeSpeech(markedText, mediaDir);
          if (shouldSuppressDuplicateVoice(chatJid)) {
            logDebugEvent('tts', 'voice_deduped', rpcSourceGroup, {
              source: 'rpc',
              chatJid,
              provider: 'freya',
            });
            return 'Voice suppressed (duplicate within dedupe window).';
          }
          await sendTelegramVoice(chatJid, oggPath);
          logDebugEvent('ipc', 'rpc_voice_sent', rpcSourceGroup, { chatJid, provider: 'freya' });
          return 'Voice sent (Freya).';
        } finally {
          if (ttsStatusId) await deleteTelegramMessage(chatJid, ttsStatusId);
        }
      }

      await sendMessage(chatJid, text);
      return 'No TTS provider configured, sent as text.';
    },
    sendFile: async ({ chatJid, filePath, caption }, rpcSourceGroup) => {
      let hostFilePath = '';
      if (filePath.startsWith('/workspace/group/')) {
        hostFilePath = path.join(
          GROUPS_DIR,
          rpcSourceGroup,
          filePath.slice('/workspace/group/'.length),
        );
      } else if (filePath.startsWith('/workspace/global/')) {
        hostFilePath = path.join(
          GROUPS_DIR,
          'global',
          filePath.slice('/workspace/global/'.length),
        );
      } else {
        throw new Error('File path must start with /workspace/group/ or /workspace/global/');
      }

      if (!fs.existsSync(hostFilePath)) {
        throw new Error(`File not found on host: ${hostFilePath}`);
      }

      await sendTelegramDocument(chatJid, hostFilePath, caption || undefined);
      logDebugEvent('ipc', 'rpc_file_sent', rpcSourceGroup, { chatJid, file: hostFilePath });
      return 'File sent.';
    },
    handleTaskAction: async (payload, rpcSourceGroup, isMain) => {
      await processTaskIpc(payload as Parameters<typeof processTaskIpc>[0], rpcSourceGroup, isMain);
      return 'Task action handled.';
    },
    handleBrowseAction: async (rpcSourceGroup, action, params) =>
      handleBrowseRpc(rpcSourceGroup, action, params),
    processStatusEvents,
  });
}

async function handleContainerRpcEvent(
  sourceGroup: string,
  evt: HostRpcEvent,
): Promise<void> {
  await routeHostRpcEvent(sourceGroup, evt, {
    processStatusEvents,
  });
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
                  logDebugEvent('ipc', 'message_sent', sourceGroup, { chatJid: data.chatJid });
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
                // Voice message via TTS (Qwen3-TTS primary, Freya fallback)
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const ipcVoiceProfile = isTTSEnabled()
                    ? (loadUnifiedVoiceProfile(sourceGroup) ?? defaultUnifiedVoiceProfile())
                    : null;

                  if (ipcVoiceProfile) {
                    // TTS via unified dispatch (self-hosted or Replicate)
                    const ttsStatusId = await sendTelegramStatusMessage(data.chatJid, 'speaking');
                    try {
                      const mediaDir = path.join(GROUPS_DIR, sourceGroup, 'media');
                      const oggPath = await synthesizeTTS(data.text, ipcVoiceProfile, mediaDir, sourceGroup);
                      if (shouldSuppressDuplicateVoice(data.chatJid)) {
                        logDebugEvent('tts', 'voice_deduped', sourceGroup, {
                          source: 'ipc',
                          chatJid: data.chatJid,
                          provider: ipcVoiceProfile.provider,
                        });
                      } else {
                        await sendTelegramVoice(data.chatJid, oggPath);
                        logDebugEvent('ipc', 'voice_sent', sourceGroup, { chatJid: data.chatJid, provider: ipcVoiceProfile.provider });
                      }
                      logger.info(
                        {
                          module: 'index',
                          chatJid: data.chatJid,
                          sourceGroup,
                          provider: ipcVoiceProfile.provider,
                          mode: ipcVoiceProfile.mode,
                        },
                        'IPC voice message sent via TTS',
                      );
                    } catch (err) {
                      logger.error(
                        { module: 'index', err, chatJid: data.chatJid, provider: ipcVoiceProfile.provider },
                        'TTS failed, falling back to text',
                      );
                      await sendMessage(data.chatJid, data.text);
                    } finally {
                      if (ttsStatusId) await deleteTelegramMessage(data.chatJid, ttsStatusId);
                    }
                  } else if (isFreyaEnabled()) {
                    // Freya TTS (archived fallback)
                    const ttsStatusId = await sendTelegramStatusMessage(data.chatJid, 'speaking');
                    try {
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
                      const mediaDir = path.join(GROUPS_DIR, sourceGroup, 'media');
                      const oggPath = await synthesizeSpeech(markedText, mediaDir);
                      if (shouldSuppressDuplicateVoice(data.chatJid)) {
                        logDebugEvent('tts', 'voice_deduped', sourceGroup, {
                          source: 'ipc',
                          chatJid: data.chatJid,
                          provider: 'freya',
                        });
                      } else {
                        await sendTelegramVoice(data.chatJid, oggPath);
                        logDebugEvent('ipc', 'voice_sent', sourceGroup, { chatJid: data.chatJid, provider: 'freya' });
                      }
                      logger.info(
                        {
                          module: 'index',
                          chatJid: data.chatJid,
                          sourceGroup,
                          emotion: emotion.name,
                        },
                        'IPC voice message sent (Freya)',
                      );
                    } catch (err) {
                      logger.error(
                        { module: 'index', err, chatJid: data.chatJid },
                        'Freya TTS failed, falling back to text',
                      );
                      await sendMessage(data.chatJid, data.text);
                    } finally {
                      if (ttsStatusId) await deleteTelegramMessage(data.chatJid, ttsStatusId);
                    }
                  } else {
                    logger.warn(
                      { module: 'index', sourceGroup },
                      'send_voice used but no TTS provider configured, sending as text',
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
                      logDebugEvent('ipc', 'file_sent', sourceGroup, { chatJid: data.chatJid, file: hostFilePath });
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

                // Emit activity event for trajectory
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
              logDebugEvent('browse', 'action_complete', sourceGroup, {
                action,
                requestId,
                status: result.status,
                durationMs: browseDurationMs,
                total: usage.total,
                ok: usage.ok,
                failed: usage.failed,
              });

              // Emit activity end event for trajectory
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
            await processStatusEvents(sourceGroup, events);
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

/**
 * Handle a single message with concurrency limiting.
 * Called directly from grammY runner handlers (no polling).
 */
async function handleMessage(msg: NewMessage): Promise<void> {
  await agentSemaphore.acquire();
  try {
    await processMessage(msg);
  } catch (err) {
    logger.error(
      { module: 'index', err, msg: msg.id },
      'Error processing message',
    );
  } finally {
    agentSemaphore.release();
  }
}

/**
 * Process any messages that arrived while the bot was offline.
 * Runs once at startup, then hands off to grammY runner for real-time processing.
 */
async function catchUpMissedMessages(): Promise<void> {
  try {
    const jids = Object.keys(registeredGroups);
    const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

    if (messages.length > 0) {
      logger.info({ module: 'index', count: messages.length }, 'Catching up missed messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { module: 'index', err, msg: msg.id },
            'Error processing catch-up message',
          );
          break;
        }
      }
    }
  } catch (err) {
    logger.error({ module: 'index', err }, 'Error catching up missed messages');
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

async function ensureDockerImageRequirements(): Promise<void> {
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

  const imageReady = await ensureAgentImage();
  if (imageReady) {
    logger.debug({ module: 'index', image: CONTAINER_IMAGE }, 'Agent image is available');
  } else {
    throw new Error(`Missing Docker image: ${CONTAINER_IMAGE} (auto-rebuild failed)`);
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

// ---------------------------------------------------------------------------
// TTS server subprocess (auto-start when QWEN_TTS_URL points to localhost)
// ---------------------------------------------------------------------------

let ttsProcess: ChildProcess | null = null;

function shouldAutoStartTts(): boolean {
  if (!QWEN_TTS_ENABLED || !QWEN_TTS_URL) return false;
  try {
    const url = new URL(QWEN_TTS_URL);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}

function startTtsServer(): void {
  const ttsDir = path.join(import.meta.dir, '..', 'tts-server');
  if (!fs.existsSync(path.join(ttsDir, 'server.py'))) {
    logger.warn({ module: 'tts' }, 'tts-server/server.py not found, skipping TTS auto-start');
    return;
  }

  logger.info({ module: 'tts', url: QWEN_TTS_URL }, 'Starting local TTS server');
  ttsProcess = spawn('uv', ['run', 'server.py'], {
    cwd: ttsDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  ttsProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      logger.info({ module: 'tts' }, line);
    }
  });

  ttsProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      logger.info({ module: 'tts' }, line);
    }
  });

  ttsProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logger.error({ module: 'tts', code }, 'TTS server exited unexpectedly');
    }
    ttsProcess = null;
  });
}

function stopTtsServer(): void {
  if (ttsProcess) {
    logger.info({ module: 'tts' }, 'Stopping TTS server');
    ttsProcess.kill('SIGTERM');
    ttsProcess = null;
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
  await ensureDockerImageRequirements();
  cleanupOrphanPersistentContainers();
  initDatabase();
  logger.info({ module: 'index' }, 'Database initialized');
  initTrajectoryPersistence();
  initLogSync();
  pruneOldLogEntries();
  pruneDebugEventEntries();
  loadState();
  // Clean up old media files on startup (7 day retention)
  for (const group of Object.values(registeredGroups)) {
    cleanupOldMedia(path.join(GROUPS_DIR, group.folder, 'media'), 7);
  }

  const schedulerDeps = {
    sendMessage,
    registeredGroups: () => registeredGroups,
    handleHostRpcRequest: (sourceGroup: string, req: HostRpcRequest) =>
      handleContainerRpcRequest(sourceGroup, req),
  };

  const taskActions: TaskActionHandler = {
    runTaskNow: (taskId: string) => runTaskNow(taskId, schedulerDeps),
  };

  if (shouldAutoStartTts()) startTtsServer();
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

  // Connect Telegram with grammY runner for concurrent processing.
  // The onMessageStored callback triggers agent processing directly from handlers.
  const onMessageStored: OnMessageStored = async (msg) => {
    // Advance lastTimestamp for catch-up tracking
    if (msg.timestamp > lastTimestamp) {
      lastTimestamp = msg.timestamp;
      saveState();
    }
    // Process the message with concurrency limiting
    void handleMessage(msg);
  };

  const runnerHandle = await connectTelegram(
    () => registeredGroups,
    registerGroup,
    taskActions,
    interruptHandler,
    onMessageStored,
  );

  // Catch-up disabled — grammY runner handles missed messages on reconnect.
  startSchedulerLoop(schedulerDeps);
  startIpcWatcher();
  startIdleWatcher();
  startContainerIdleCleanup();

  logger.info({ module: 'index' }, `NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  // Keep the process alive via the runner handle
  await runnerHandle.task();
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ module: 'index', signal }, 'Shutting down');
    // Stop accepting new updates, wait for in-flight handlers (30s timeout)
    const stopPromise = stopTelegram();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
    await Promise.race([stopPromise, timeout]);
    killAllContainers();
    await disconnectBrowser();
    stopTtsServer();
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
