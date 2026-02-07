/**
 * NanoClaw Agent Runner
 * Runs inside a container in two modes:
 * - One-shot (stdin): receives config via stdin, outputs result to stdout, exits
 * - Persistent (file-watching): watches IPC dir for input files, processes them, writes output files, loops
 *
 * Persistent mode eliminates ~3s SDK import + CLI spawn overhead per message by
 * keeping the process alive and reusing the imported SDK.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';

// ─── Shared Types ────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const AGENT_INPUT_DIR = '/workspace/ipc/agent-input';
const AGENT_OUTPUT_DIR = '/workspace/ipc/agent-output';
const HEARTBEAT_FILE = '/workspace/ipc/agent-heartbeat';

const INPUT_POLL_INTERVAL = 200;  // ms - fast polling for responsive feel
const HEARTBEAT_INTERVAL = 10000; // ms - 10 seconds

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Atomically write a file using temp + rename pattern.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

const STATUS_DIR = '/workspace/ipc/status';

function writeStatusEvent(event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filename = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    atomicWriteFileSync(path.join(STATUS_DIR, filename), JSON.stringify(event));
  } catch {
    // Best effort - don't break agent on status write failure
  }
}

function updateHeartbeat(): void {
  try {
    atomicWriteFileSync(HEARTBEAT_FILE, JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      iso: new Date().toISOString(),
    }));
  } catch (err) {
    log(`Failed to update heartbeat: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Transcript / Session Helpers ────────────────────────────────────────────

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Agent Execution (shared by both modes) ──────────────────────────────────

async function runQuery(input: ContainerInput): Promise<ContainerOutput> {
  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  try {
    log('Starting agent query...');

    for await (const message of query({
      prompt,
      options: {
        cwd: '/workspace/group',
        resume: input.sessionId,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__nanoclaw__*'
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: ipcMcp
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook()] }]
        }
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if ('result' in message && message.result) {
        result = message.result as string;
      }

      // Transparency: write status events for host to forward to Telegram
      if (message.type === 'assistant' && 'message' in message) {
        const msg = message.message as { content?: Array<{ type: string; name?: string; input?: unknown }> };
        const toolUses = msg.content?.filter((b: { type: string }) => b.type === 'tool_use') || [];
        for (const tu of toolUses) {
          writeStatusEvent({
            type: 'tool_start',
            tool_name: (tu as { name?: string }).name || 'unknown',
            preview: JSON.stringify((tu as { input?: unknown }).input).slice(0, 200),
          });
        }
      }
      if (message.type === 'tool_progress' && 'tool_name' in message) {
        writeStatusEvent({
          type: 'tool_progress',
          tool_name: (message as { tool_name: string }).tool_name,
          elapsed_seconds: (message as { elapsed_time_seconds?: number }).elapsed_time_seconds,
        });
      }
    }

    log('Agent query completed successfully');
    return {
      status: 'success',
      result,
      newSessionId
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return {
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage
    };
  }
}

// ─── One-shot Mode (stdin/stdout, backward compatible) ───────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function runOneShotMode(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`[one-shot] Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const output = await runQuery(input);
  writeOutput(output);

  if (output.status === 'error') {
    process.exit(1);
  }
}

// ─── Persistent Mode (file-watching loop) ────────────────────────────────────

/**
 * Scan the input directory for .json files, sorted by name (timestamp order).
 */
function scanInputFiles(): string[] {
  try {
    if (!fs.existsSync(AGENT_INPUT_DIR)) return [];
    return fs.readdirSync(AGENT_INPUT_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort();
  } catch {
    return [];
  }
}

async function processInputFile(filename: string): Promise<void> {
  const inputPath = path.join(AGENT_INPUT_DIR, filename);
  const timestamp = filename.replace(/^req-/, '').replace(/\.json$/, '');
  const outputPath = path.join(AGENT_OUTPUT_DIR, `res-${timestamp}.json`);

  log(`[persistent] Processing: ${filename}`);

  let input: ContainerInput;
  try {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    input = JSON.parse(raw);
  } catch (err) {
    log(`[persistent] Failed to read input file ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    // Write error output so host doesn't wait forever
    const errorOutput: ContainerOutput = {
      status: 'error',
      result: null,
      error: `Failed to parse input file: ${err instanceof Error ? err.message : String(err)}`
    };
    atomicWriteFileSync(outputPath, JSON.stringify(errorOutput));
    // Remove the bad input file
    try { fs.unlinkSync(inputPath); } catch {}
    return;
  }

  // Delete input file immediately so it won't be re-processed on restart
  try { fs.unlinkSync(inputPath); } catch {}

  // Run the query
  const output = await runQuery(input);

  // Write output atomically
  atomicWriteFileSync(outputPath, JSON.stringify(output));
  log(`[persistent] Completed: ${filename} -> res-${timestamp}.json (status: ${output.status})`);
}

async function runPersistentMode(): Promise<void> {
  log('[persistent] Starting persistent mode (file-watching loop)');

  // Ensure IPC directories exist
  fs.mkdirSync(AGENT_INPUT_DIR, { recursive: true });
  fs.mkdirSync(AGENT_OUTPUT_DIR, { recursive: true });

  // Start heartbeat
  updateHeartbeat();
  const heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL);

  // Signal readiness by writing initial heartbeat
  log('[persistent] Agent ready, watching for input files');

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[persistent] Received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
    // Remove heartbeat file to signal we're gone
    try { fs.unlinkSync(HEARTBEAT_FILE); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Main loop: poll for input files
  while (!shuttingDown) {
    try {
      const files = scanInputFiles();
      if (files.length > 0) {
        // Process files one at a time (serial to avoid concurrent SDK issues)
        for (const file of files) {
          if (shuttingDown) break;
          await processInputFile(file);
          // Update heartbeat after each processed file
          updateHeartbeat();
        }
      }
    } catch (err) {
      log(`[persistent] Error in main loop: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, INPUT_POLL_INTERVAL));
  }
}

// ─── Mode Detection & Entry Point ────────────────────────────────────────────

async function main(): Promise<void> {
  // Mode detection:
  // - NANOCLAW_PERSISTENT=1 env var -> persistent mode
  // - stdin is a TTY (no piped data) -> persistent mode
  // - stdin has piped data -> one-shot mode
  const forcePersistent = process.env.NANOCLAW_PERSISTENT === '1';

  if (forcePersistent) {
    log('Mode: persistent (NANOCLAW_PERSISTENT=1)');
    await runPersistentMode();
  } else if (process.stdin.isTTY) {
    // No stdin data piped - default to persistent
    log('Mode: persistent (no stdin detected)');
    await runPersistentMode();
  } else {
    // stdin has data - one-shot mode for backward compatibility
    log('Mode: one-shot (stdin detected)');
    await runOneShotMode();
  }
}

main();
