/**
 * Voice call manager — Docker sidecar lifecycle, audio pipeline (STT → Agent → TTS).
 *
 * Follows the sandbox-manager.ts pattern for Docker lifecycle.
 * The pytgcalls sidecar handles WebRTC/MTProto; this module handles
 * the host-side processing pipeline.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  VOICE_CALL_ENABLED,
  VOICE_SIDECAR_IMAGE,
  VOICE_SIDECAR_CONTAINER_NAME,
  VOICE_SIDECAR_API_PORT,
  VOICE_CALLBACK_PORT,
  VOICE_CALL_IDLE_TIMEOUT_MS,
  VOICE_VAD_SILENCE_MS,
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_BOT_TOKEN,
  GROUPS_DIR,
  ASSISTANT_NAME,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { logger } from './logger.js';
import { transcribeAudio } from './media.js';
import {
  isTTSEnabled,
  loadUnifiedVoiceProfile,
  defaultUnifiedVoiceProfile,
  synthesizeTTS,
} from './tts-dispatch.js';
import type { RegisteredGroup } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface VoiceCallState {
  active: boolean;
  chatId: number;
  chatJid: string;
  groupFolder: string;
  group: RegisteredGroup;
  joinedAt: number;
  lastActivityAt: number;
  conversationContext: VoiceTurn[];
}

interface VoiceTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

let callState: VoiceCallState | null = null;
let idleWatcherInterval: ReturnType<typeof setInterval> | null = null;
let processing = false;

const MAX_CONTEXT_TURNS = 10;

// ─── Callbacks (set by index.ts wiring) ──────────────────────────────────────

type AgentRunner = (
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
) => Promise<string | null>;

type MessageSender = (chatJid: string, text: string) => Promise<void>;

let runAgentFn: AgentRunner | null = null;
let sendMessageFn: MessageSender | null = null;

export function setVoiceCallAgentRunner(fn: AgentRunner): void {
  runAgentFn = fn;
}

export function setVoiceCallMessageSender(fn: MessageSender): void {
  sendMessageFn = fn;
}

// ─── Docker Lifecycle ────────────────────────────────────────────────────────

function isContainerRunning(): boolean {
  try {
    const result = execSync(
      `docker inspect --format '{{.State.Running}}' ${VOICE_SIDECAR_CONTAINER_NAME}`,
      { stdio: 'pipe' },
    ).toString().trim();
    return result === 'true';
  } catch {
    return false;
  }
}

function removeContainerIfPresent(): void {
  try {
    execSync(`docker rm -f ${VOICE_SIDECAR_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container may not exist
  }
}

function startSidecar(): void {
  removeContainerIfPresent();

  logger.info({ module: 'voice-call' }, 'Starting voice sidecar container');

  const args = [
    'docker run -d',
    `--name ${VOICE_SIDECAR_CONTAINER_NAME}`,
    `-p ${VOICE_SIDECAR_API_PORT}:8100`,
    `-e TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}`,
    `-e TELEGRAM_API_ID=${TELEGRAM_API_ID}`,
    `-e TELEGRAM_API_HASH=${TELEGRAM_API_HASH}`,
    `-e HOST_CALLBACK_URL=http://host.docker.internal:${VOICE_CALLBACK_PORT}/voice-utterance`,
    `-e VAD_SILENCE_MS=${VOICE_VAD_SILENCE_MS}`,
    '--add-host host.docker.internal:host-gateway',
    VOICE_SIDECAR_IMAGE,
  ];

  try {
    execSync(args.join(' '), { stdio: 'pipe' });
    logger.info({ module: 'voice-call' }, 'Voice sidecar container started');
  } catch (err) {
    logger.error({ module: 'voice-call', err }, 'Failed to start voice sidecar');
    throw err;
  }
}

function stopSidecar(): void {
  logger.info({ module: 'voice-call' }, 'Stopping voice sidecar container');
  try {
    execSync(`docker stop ${VOICE_SIDECAR_CONTAINER_NAME}`, { stdio: 'pipe', timeout: 15000 });
  } catch {
    // Container may not be running
  }
  removeContainerIfPresent();
}

function waitForSidecarReady(): void {
  const url = `http://localhost:${VOICE_SIDECAR_API_PORT}/health`;
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`curl -sf ${url}`, { stdio: 'pipe', timeout: 3000 });
      logger.info({ module: 'voice-call' }, 'Voice sidecar is ready');
      return;
    } catch {
      if (i === 29) {
        logger.warn({ module: 'voice-call' }, 'Voice sidecar not reachable after 30 attempts');
      }
      execSync('sleep 1', { stdio: 'pipe' });
    }
  }
}

async function ensureSidecar(): Promise<void> {
  if (!isContainerRunning()) {
    startSidecar();
    waitForSidecarReady();
  }
}

// ─── Sidecar API ─────────────────────────────────────────────────────────────

async function sidecarRequest(
  method: string,
  endpoint: string,
  body?: unknown,
  formData?: FormData,
): Promise<unknown> {
  const url = `http://localhost:${VOICE_SIDECAR_API_PORT}${endpoint}`;
  const headers: Record<string, string> = {};
  let requestBody: BodyInit | undefined;

  if (formData) {
    requestBody = formData;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: requestBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sidecar ${endpoint} failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function isVoiceCallActive(): boolean {
  return callState?.active ?? false;
}

export function getVoiceCallState(): VoiceCallState | null {
  return callState;
}

export async function joinVoiceCall(
  chatId: number,
  chatJid: string,
  group: RegisteredGroup,
): Promise<string> {
  if (!VOICE_CALL_ENABLED) {
    return 'Voice calls are not enabled. Set VOICE_CALL_ENABLED=true in .env';
  }
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    return 'Missing TELEGRAM_API_ID or TELEGRAM_API_HASH. Get them from https://my.telegram.org/auth';
  }
  if (!isTTSEnabled()) {
    return 'TTS is not enabled. Voice calls require a TTS provider.';
  }
  if (callState?.active) {
    return `Already in a voice call (chat ${callState.chatId})`;
  }

  try {
    await ensureSidecar();

    await sidecarRequest('POST', '/join', { chat_id: chatId });

    callState = {
      active: true,
      chatId,
      chatJid,
      groupFolder: group.folder,
      group,
      joinedAt: Date.now(),
      lastActivityAt: Date.now(),
      conversationContext: [],
    };

    startIdleWatcher();

    logger.info(
      { module: 'voice-call', chatId, group: group.name },
      'Joined voice call',
    );
    return `Joined voice call. Speak in the voice chat and I'll respond. Send /hangup to leave.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'voice-call', err: msg }, 'Failed to join voice call');
    return `Failed to join voice call: ${msg}`;
  }
}

export async function leaveVoiceCall(): Promise<string> {
  if (!callState?.active) {
    return 'Not in a voice call.';
  }

  try {
    await sidecarRequest('POST', '/leave');
  } catch (err) {
    logger.warn(
      { module: 'voice-call', err: err instanceof Error ? err.message : String(err) },
      'Error sending leave to sidecar',
    );
  }

  const duration = Math.round((Date.now() - callState.joinedAt) / 1000);
  const turns = callState.conversationContext.length;
  callState = null;

  stopIdleWatcher();

  logger.info({ module: 'voice-call', duration, turns }, 'Left voice call');
  return `Left voice call. Duration: ${duration}s, ${turns} exchanges.`;
}

export function getVoiceCallStatus(): string {
  if (!callState?.active) {
    return 'No active voice call.';
  }
  const duration = Math.round((Date.now() - callState.joinedAt) / 1000);
  const lastActivity = callState.lastActivityAt
    ? Math.round((Date.now() - callState.lastActivityAt) / 1000)
    : 0;
  const turns = callState.conversationContext.length;
  return [
    `Voice call active in chat ${callState.chatId}`,
    `Duration: ${duration}s`,
    `Last speech: ${lastActivity}s ago`,
    `Turns: ${turns}`,
    `Group: ${callState.group.name}`,
  ].join('\n');
}

// ─── Utterance Pipeline ──────────────────────────────────────────────────────

/**
 * Core pipeline: STT → Agent → TTS → Play
 * Called by the voice callback server when the sidecar sends an utterance.
 */
export async function handleUtterance(wavBuffer: Buffer, chatId: string): Promise<void> {
  if (!callState?.active || !runAgentFn) {
    logger.warn({ module: 'voice-call' }, 'Utterance received but no active call or agent runner');
    return;
  }

  if (processing) {
    logger.info({ module: 'voice-call' }, 'Already processing an utterance, skipping');
    return;
  }

  processing = true;
  const pipelineStart = Date.now();

  try {
    callState.lastActivityAt = Date.now();

    // 1. Save WAV to temp file for STT
    const tmpDir = os.tmpdir();
    const wavPath = path.join(tmpDir, `voice-utterance-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);

    // 2. STT: transcribe audio
    const sttStart = Date.now();
    const transcription = await transcribeAudio(wavPath);
    const sttMs = Date.now() - sttStart;
    logger.info({ module: 'voice-call', sttMs, textLength: transcription.length }, 'STT complete');

    // Clean up temp WAV
    try { fs.unlinkSync(wavPath); } catch {}

    if (!transcription || transcription === '[transcription unavailable]' || transcription === '[transcription failed]') {
      logger.info({ module: 'voice-call' }, 'Empty or failed transcription, skipping');
      return;
    }

    // 3. Build voice-mode prompt with context
    callState.conversationContext.push({
      role: 'user',
      content: transcription,
      timestamp: Date.now(),
    });

    // Trim context to last N turns
    while (callState.conversationContext.length > MAX_CONTEXT_TURNS) {
      callState.conversationContext.shift();
    }

    const contextXml = callState.conversationContext
      .map((t) => `<message role="${t.role}">${escapeXml(t.content)}</message>`)
      .join('\n');

    const prompt = [
      '<voice_call_mode>',
      'You are in a LIVE VOICE CALL. Keep responses SHORT (1-3 sentences). Be conversational and natural. No markdown, formatting, links, or code blocks. Respond as if speaking aloud.',
      '</voice_call_mode>',
      '<voice_conversation>',
      contextXml,
      '</voice_conversation>',
    ].join('\n');

    // 4. Run agent
    const agentStart = Date.now();
    const response = await runAgentFn(callState.group, prompt, callState.chatJid);
    const agentMs = Date.now() - agentStart;
    logger.info({ module: 'voice-call', agentMs, responseLength: response?.length ?? 0 }, 'Agent complete');

    if (!response) {
      logger.warn({ module: 'voice-call' }, 'Agent returned no response');
      return;
    }

    // Strip think tags and clean response
    const cleanResponse = response
      .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
      .replace(/---voice---/g, '')
      .trim();

    if (!cleanResponse) return;

    // Add to context
    callState.conversationContext.push({
      role: 'assistant',
      content: cleanResponse,
      timestamp: Date.now(),
    });

    // 5. TTS: synthesize response
    const ttsStart = Date.now();
    const profile = loadUnifiedVoiceProfile(callState.groupFolder)
      ?? defaultUnifiedVoiceProfile();
    const mediaDir = path.join(GROUPS_DIR, callState.groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const oggPath = await synthesizeTTS(cleanResponse, profile, mediaDir, callState.groupFolder);
    const ttsMs = Date.now() - ttsStart;
    logger.info({ module: 'voice-call', ttsMs }, 'TTS complete');

    // 6. Convert OGG to WAV for sidecar playback
    const playWavPath = oggPath.replace(/\.ogg$/, '-play.wav');
    try {
      execSync(
        `ffmpeg -y -i "${oggPath}" -ar 48000 -ac 1 -sample_fmt s16 "${playWavPath}"`,
        { stdio: 'pipe', timeout: 30000 },
      );
    } catch (err) {
      logger.error({ module: 'voice-call', err }, 'ffmpeg conversion failed');
      return;
    }

    // 7. Send audio to sidecar for playback
    const wavData = fs.readFileSync(playWavPath);
    const formData = new FormData();
    formData.append('audio', new Blob([wavData], { type: 'audio/wav' }), 'response.wav');

    await sidecarRequest('POST', '/play', undefined, formData);

    // Clean up
    try { fs.unlinkSync(playWavPath); } catch {}
    try { fs.unlinkSync(oggPath); } catch {}

    const totalMs = Date.now() - pipelineStart;
    logger.info(
      { module: 'voice-call', totalMs, sttMs, agentMs, ttsMs },
      'Voice pipeline complete',
    );

  } catch (err) {
    logger.error(
      { module: 'voice-call', err: err instanceof Error ? err.message : String(err) },
      'Voice pipeline error',
    );
  } finally {
    processing = false;
  }
}

// ─── Idle Watcher ────────────────────────────────────────────────────────────

function startIdleWatcher(): void {
  if (idleWatcherInterval) return;
  idleWatcherInterval = setInterval(async () => {
    if (
      callState?.active &&
      Date.now() - callState.lastActivityAt > VOICE_CALL_IDLE_TIMEOUT_MS
    ) {
      logger.info({ module: 'voice-call' }, 'Voice call idle timeout, leaving');
      if (sendMessageFn) {
        await sendMessageFn(
          callState.chatJid,
          'Voice call ended due to inactivity.',
        );
      }
      await leaveVoiceCall();
    }
  }, 60_000);
}

function stopIdleWatcher(): void {
  if (idleWatcherInterval) {
    clearInterval(idleWatcherInterval);
    idleWatcherInterval = null;
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function cleanupVoiceCall(): Promise<void> {
  stopIdleWatcher();
  if (callState?.active) {
    try {
      await sidecarRequest('POST', '/leave');
    } catch {}
    callState = null;
  }
  if (isContainerRunning()) {
    stopSidecar();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
