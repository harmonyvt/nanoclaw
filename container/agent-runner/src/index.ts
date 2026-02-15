/**
 * NanoClaw Agent Runner
 * Runs inside a container in two modes:
 * - One-shot (stdin): receives config via stdin, outputs result to stdout, exits
 * - Persistent (RPC server): listens on a Unix socket, processes run_query requests, loops
 *
 * Persistent mode eliminates ~3s SDK import + CLI spawn overhead per message by
 * keeping the process alive and reusing the imported SDK.
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { createAdapter } from './adapters/index.js';
import { isCancelled, clearCancelFile } from './cancel.js';
import type { ContainerInput, ContainerOutput, AdapterInput } from './types.js';
import type { HostRpcBridge } from './host-rpc.js';
import { makeHostEvent, makeHostRequest, withHostRpcBridge } from './host-rpc.js';
import type { RpcMessage, RpcResponseMessage } from './rpc-protocol.js';
import { parseRpcLines, serializeRpcMessage } from './rpc-protocol.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const AGENT_RPC_SOCKET = '/workspace/ipc/agent.sock';
const HEARTBEAT_FILE = '/workspace/ipc/agent-heartbeat';

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

function emitStatusEvent(
  event: Record<string, unknown>,
  bridge?: HostRpcBridge,
): void {
  if (bridge) {
    bridge.notify('status.event', event);
    return;
  }
  writeStatusEvent(event);
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

  if (input.isVoiceCall) {
    prompt = `[VOICE CALL - You are in a live voice conversation. Keep responses SHORT (1-3 sentences). Be conversational and natural. No markdown, formatting, links, code blocks, or lists. Respond as if speaking aloud.]\n\n${prompt}`;
  }

  return prompt;
}

// ─── Agent Execution (shared by both modes) ──────────────────────────────────

async function runQuery(
  input: ContainerInput,
  bridge?: HostRpcBridge,
): Promise<ContainerOutput> {
  let result: string | null = null;

  const prompt = preparePrompt(input);
  const provider = input.provider || 'anthropic';
  const adapter = createAdapter(provider);

  const adapterInput: AdapterInput = {
    prompt,
    model: input.model,
    baseUrl: input.baseUrl,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask,
    assistantName: input.assistantName,
    enableThinking: input.enableThinking,
    ipcContext: {
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
    },
  };

  try {
    log('Starting agent query...');

    await withHostRpcBridge(bridge || null, async () => {
      for await (const event of adapter.run(adapterInput)) {
        // Check for user interrupt between events
        if (isCancelled()) {
          log('Cancel file detected, aborting query');
          clearCancelFile();
          result = result || '[Interrupted by user]';
          return;
        }

        switch (event.type) {
          case 'session_init':
            log(`Session initialized: ${event.sessionId}`);
            break;
          case 'result':
            result = event.result;
            break;
          case 'tool_start':
            emitStatusEvent(
              { type: 'tool_start', tool_name: event.toolName, preview: event.preview },
              bridge,
            );
            break;
          case 'tool_progress':
            emitStatusEvent(
              {
                type: 'tool_progress',
                tool_name: event.toolName,
                elapsed_seconds: event.elapsedSeconds,
              },
              bridge,
            );
            break;
          case 'thinking':
            emitStatusEvent({ type: 'thinking', content: event.content }, bridge);
            break;
          case 'response_delta':
            emitStatusEvent({ type: 'response_delta', content: event.content }, bridge);
            break;
          case 'adapter_stderr':
            emitStatusEvent(
              { type: 'adapter_stderr', message: event.message },
              bridge,
            );
            break;
        }
      }
    });

    log('Agent query completed successfully');
    return { status: 'success', result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return { status: 'error', result: null, error: errorMessage };
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

// ─── Persistent Mode (Unix socket RPC server) ───────────────────────────────

interface RpcConnectionState {
  buffer: string;
  running: boolean;
  nextRequestId: number;
  pendingHostResponses: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >;
}

function sendRpcMessage(socket: net.Socket, msg: RpcMessage): void {
  socket.write(serializeRpcMessage(msg));
}

function createHostBridge(
  socket: net.Socket,
  state: RpcConnectionState,
): HostRpcBridge {
  return {
    request(method: string, params?: unknown): Promise<unknown> {
      const requestId = `host-${++state.nextRequestId}`;
      const request = makeHostRequest(requestId, method, params);

      return new Promise((resolve, reject) => {
        state.pendingHostResponses.set(requestId, { resolve, reject });
        try {
          sendRpcMessage(socket, request);
        } catch (err) {
          state.pendingHostResponses.delete(requestId);
          reject(err);
        }
      });
    },
    notify(method: string, params?: unknown): void {
      try {
        sendRpcMessage(socket, makeHostEvent(method, params));
      } catch {
        // Best effort: losing status notifications should not fail agent execution.
      }
    },
  };
}

function closeConnectionState(state: RpcConnectionState, reason: string): void {
  for (const { reject } of state.pendingHostResponses.values()) {
    reject(new Error(reason));
  }
  state.pendingHostResponses.clear();
}

async function runPersistentMode(): Promise<void> {
  log('[persistent] Starting persistent mode (unix socket RPC)');

  fs.mkdirSync(path.dirname(AGENT_RPC_SOCKET), { recursive: true });
  try {
    if (fs.existsSync(AGENT_RPC_SOCKET)) fs.unlinkSync(AGENT_RPC_SOCKET);
  } catch (err) {
    log(
      `[persistent] Failed to remove stale socket: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const activeSockets = new Set<net.Socket>();
  let shuttingDown = false;
  let queryInFlight = false;

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    const state: RpcConnectionState = {
      buffer: '',
      running: false,
      nextRequestId: 0,
      pendingHostResponses: new Map(),
    };
    const hostBridge = createHostBridge(socket, state);

    const handleRequest = (msg: Extract<RpcMessage, { type: 'request' }>): void => {
      if (msg.method !== 'run_query') {
        sendRpcMessage(socket, {
          type: 'response',
          id: msg.id,
          error: `Unknown method: ${msg.method}`,
        });
        return;
      }

      if (state.running || queryInFlight) {
        sendRpcMessage(socket, {
          type: 'response',
          id: msg.id,
          error: 'Agent is busy processing another request',
        });
        return;
      }

      state.running = true;
      queryInFlight = true;
      clearCancelFile();

      let input: ContainerInput;
      try {
        input = msg.params as ContainerInput;
      } catch {
        sendRpcMessage(socket, {
          type: 'response',
          id: msg.id,
          error: 'Invalid run_query payload',
        });
        state.running = false;
        return;
      }

      void (async () => {
        const output = await runQuery(input, hostBridge);
        const response: RpcResponseMessage = {
          type: 'response',
          id: msg.id,
          result: output,
        };
        sendRpcMessage(socket, response);
        state.running = false;
        queryInFlight = false;
        updateHeartbeat();
      })().catch((err) => {
        sendRpcMessage(socket, {
          type: 'response',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
        state.running = false;
        queryInFlight = false;
      });
    };

    socket.on('data', (chunk) => {
      const parsed = parseRpcLines(chunk.toString('utf8'), state.buffer);
      state.buffer = parsed.buffer;

      for (const msg of parsed.messages) {
        if (msg.type === 'request') {
          handleRequest(msg);
          continue;
        }

        if (msg.type === 'response') {
          const pending = state.pendingHostResponses.get(msg.id);
          if (!pending) continue;
          state.pendingHostResponses.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
          continue;
        }
      }
    });

    socket.on('error', (err) => {
      log(`[persistent] Socket error: ${err.message}`);
    });

    socket.on('close', () => {
      activeSockets.delete(socket);
      closeConnectionState(state, 'Host RPC socket closed');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(AGENT_RPC_SOCKET, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // Start heartbeat only after socket is ready.
  updateHeartbeat();
  const heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL);
  log('[persistent] Agent ready, accepting RPC requests');

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[persistent] Received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);

    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }

    try {
      server.close();
    } catch {
      // ignore
    }

    try {
      if (fs.existsSync(HEARTBEAT_FILE)) fs.unlinkSync(HEARTBEAT_FILE);
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(AGENT_RPC_SOCKET)) fs.unlinkSync(AGENT_RPC_SOCKET);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await new Promise<void>(() => {
    // keep process alive until a signal triggers shutdown
  });
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

if (import.meta.main) {
  void main();
}
