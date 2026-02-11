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
import { createAdapter } from './adapters/index.js';
import { isCancelled, clearCancelFile } from './cancel.js';
import type { ContainerInput, ContainerOutput, AdapterInput } from './types.js';

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

// ─── Prompt Preparation ─────────────────────────────────────────────────────

export function preparePrompt(input: ContainerInput): string {
  let prompt = input.prompt;

  // Inject SOUL.md personality into prompt
  const soulPath = '/workspace/group/SOUL.md';
  const voiceProfilePath = '/workspace/group/voice_profile.json';
  try {
    if (fs.existsSync(soulPath)) {
      const soulContent = fs.readFileSync(soulPath, 'utf-8').trim();
      if (soulContent) {
        prompt = `<soul>\n${soulContent}\n</soul>\n\n${prompt}`;
      }
      // Auto-generate voice profile if SOUL exists but voice_profile.json doesn't
      if (!fs.existsSync(voiceProfilePath) && !input.isScheduledTask) {
        prompt += '\n<voice_setup>\nYou have a personality but no voice profile yet. Based on your SOUL.md personality, create /workspace/group/voice_profile.json with a voice that matches this personality. Use voice_design mode with a natural language description of how this personality should sound (age, gender, tone, accent, speaking style).\n\nFormat: {"provider":"qwen3-tts","mode":"voice_design","voice_design":{"description":"<describe the voice>","language":"English"},"created_at":"<ISO timestamp>","updated_at":"<ISO timestamp>"}\n\nDo this silently before responding to the user.\n</voice_setup>\n';
      }
    } else if (!input.isScheduledTask) {
      prompt = `<soul_setup>\nYou don't have a personality defined yet (no SOUL.md file). Introduce yourself briefly and ask the user if they'd like to give you a name and personality. If they do:\n1. Create /workspace/group/SOUL.md with what they describe.\n2. Also create a matching voice profile at /workspace/group/voice_profile.json with a natural language description of how this personality should sound.\n\nVoice profile format: {"provider":"qwen3-tts","mode":"voice_design","voice_design":{"description":"<age, gender, tone, accent, style>","language":"English"},"created_at":"<ISO timestamp>","updated_at":"<ISO timestamp>"}\n\nUntil then, be helpful and friendly.\n</soul_setup>\n\n${prompt}`;
    }
  } catch (err) {
    log(`Failed to read SOUL.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${prompt}`;
  }

  if (input.isSkillInvocation) {
    prompt = `[SKILL INVOCATION - You are executing a stored skill. Follow the instructions in the <skill> block precisely. Report progress and results using send_message.]\n\n${prompt}`;
  }

  return prompt;
}

// ─── Agent Execution (shared by both modes) ──────────────────────────────────

async function runQuery(input: ContainerInput): Promise<ContainerOutput> {
  let result: string | null = null;
  let newSessionId: string | undefined;

  const prompt = preparePrompt(input);
  const provider = input.provider || 'anthropic';
  const adapter = createAdapter(provider);

  const adapterInput: AdapterInput = {
    prompt,
    sessionId: input.sessionId,
    model: input.model,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask,
    assistantName: input.assistantName,
    ipcContext: {
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
    },
  };

  try {
    log('Starting agent query...');

    for await (const event of adapter.run(adapterInput)) {
      // Check for user interrupt between events
      if (isCancelled()) {
        log('Cancel file detected, aborting query');
        clearCancelFile();
        return { status: 'success', result: result || '[Interrupted by user]', newSessionId };
      }

      switch (event.type) {
        case 'session_init':
          newSessionId = event.sessionId;
          log(`Session initialized: ${newSessionId}`);
          break;
        case 'result':
          result = event.result;
          break;
        case 'tool_start':
          writeStatusEvent({ type: 'tool_start', tool_name: event.toolName, preview: event.preview });
          break;
        case 'tool_progress':
          writeStatusEvent({ type: 'tool_progress', tool_name: event.toolName, elapsed_seconds: event.elapsedSeconds });
          break;
        case 'thinking':
          writeStatusEvent({ type: 'thinking', content: event.content });
          break;
        case 'adapter_stderr':
          writeStatusEvent({ type: 'adapter_stderr', message: event.message });
          break;
      }
    }

    log('Agent query completed successfully');
    return { status: 'success', result, newSessionId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return { status: 'error', result: null, newSessionId, error: errorMessage };
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

  // Clear stale cancel files from previous requests
  clearCancelFile();

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
