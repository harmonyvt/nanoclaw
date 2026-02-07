/**
 * OpenAI Session Management
 * Handles conversation history persistence for the OpenAI adapter.
 * History is stored as JSON files in the group's .openai-sessions directory.
 */

import fs from 'fs';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Generic message shape for OpenAI conversation history */
export interface SessionMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default directory for OpenAI session files (relative to group workspace) */
export const DEFAULT_SESSIONS_DIR = '/workspace/group/.openai-sessions';

/** Maximum number of messages to retain in history before trimming */
export const MAX_MESSAGES = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[openai-session] ${message}`);
}

/**
 * Atomically write a file using temp + rename pattern.
 * Prevents partial reads if the host or another process reads mid-write.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a unique session ID with 'openai-' prefix.
 * Format: openai-{timestamp}-{random}
 */
export function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `openai-${timestamp}-${random}`;
}

/**
 * Load conversation history for a given session.
 *
 * @param sessionId - The session ID to load history for
 * @param sessionsDir - Override the default sessions directory
 * @returns Array of session messages, or empty array if not found
 */
export function loadHistory(
  sessionId: string | undefined,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): SessionMessage[] {
  if (!sessionId) {
    return [];
  }

  const filePath = path.join(sessionsDir, `${sessionId}.json`);

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      log(`Session file ${filePath} does not contain an array, returning empty`);
      return [];
    }

    return parsed as SessionMessage[];
  } catch (err) {
    log(`Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Save conversation history for a given session, with auto-trimming.
 *
 * When the message count exceeds MAX_MESSAGES, trims to keep:
 * - The first message (system prompt)
 * - The most recent (MAX_MESSAGES - 1) messages
 *
 * Uses atomic file writes (temp + rename) to prevent corruption.
 *
 * @param sessionId - The session ID to save history for
 * @param messages - The full message array to persist
 * @param sessionsDir - Override the default sessions directory
 */
export function saveHistory(
  sessionId: string,
  messages: SessionMessage[],
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): void {
  try {
    // Ensure directory exists
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Trim if exceeding max
    let toSave = messages;
    if (messages.length > MAX_MESSAGES) {
      const systemMessage = messages[0];
      const recentMessages = messages.slice(-(MAX_MESSAGES - 1));
      toSave = [systemMessage, ...recentMessages];
      log(`Trimmed history from ${messages.length} to ${toSave.length} messages (kept system + last ${MAX_MESSAGES - 1})`);
    }

    const filePath = path.join(sessionsDir, `${sessionId}.json`);
    atomicWriteFileSync(filePath, JSON.stringify(toSave, null, 2));
  } catch (err) {
    log(`Failed to save history for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
