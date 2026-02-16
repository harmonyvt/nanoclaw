/**
 * Unix socket RPC server for persistent mode.
 * Accepts connections from the host, dispatches run_query requests,
 * relays events back, and manages host-bridge RPC bidirectionally.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import { Context, Effect, Layer } from 'effect';
import { RpcError } from '../errors/index.js';
import { HostBridge, type HostBridgeService } from '../services/HostBridge.js';
import type { RpcMessage, RpcResponseMessage, RpcRequestMessage } from '../schemas/RpcProtocol.js';
import { serializeRpcMessage, parseRpcLines } from './protocol.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const AGENT_RPC_SOCKET = '/workspace/ipc/agent.sock';
const HEARTBEAT_FILE = '/workspace/ipc/agent-heartbeat';
const HEARTBEAT_INTERVAL = 10000;

function log(msg: string): void {
  process.stderr.write(`[rpc-server] ${msg}\n`);
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

// ─── Service Interface ──────────────────────────────────────────────────────

export interface RpcServerService {
  /**
   * Register a handler for incoming run_query requests.
   * Returns the RPC-backed HostBridge so tools can use bidirectional RPC.
   */
  readonly onQuery: (
    handler: (
      params: unknown,
      bridge: HostBridgeService,
    ) => Promise<unknown>,
  ) => Effect.Effect<void>;
}

export class RpcServer extends Context.Tag('RpcServer')<
  RpcServer,
  RpcServerService
>() {}

// ─── Connection State ───────────────────────────────────────────────────────

interface ConnectionState {
  buffer: string;
  running: boolean;
  nextRequestId: number;
  pendingHostResponses: Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >;
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

/**
 * Creates the Unix socket RPC server. The Layer manages socket lifecycle:
 * creates on acquire, cleans up on release.
 */
export const RpcServerLive: Layer.Layer<RpcServer> = Layer.succeed(
  RpcServer,
  {
    onQuery: (handler) =>
      Effect.async<void, never>((resume) => {
        fs.mkdirSync(path.dirname(AGENT_RPC_SOCKET), { recursive: true });
        try {
          if (fs.existsSync(AGENT_RPC_SOCKET)) fs.unlinkSync(AGENT_RPC_SOCKET);
        } catch { /* ignore */ }

        const activeSockets = new Set<net.Socket>();
        let queryInFlight = false;

        const server = net.createServer((socket) => {
          activeSockets.add(socket);
          const state: ConnectionState = {
            buffer: '',
            running: false,
            nextRequestId: 0,
            pendingHostResponses: new Map(),
          };

          // Create a HostBridge backed by this socket connection
          const bridge: HostBridgeService = {
            request: (method, params) =>
              Effect.async<unknown, RpcError>((cb) => {
                const requestId = `host-${++state.nextRequestId}`;
                state.pendingHostResponses.set(requestId, {
                  resolve: (val) => cb(Effect.succeed(val)),
                  reject: (err) =>
                    cb(
                      Effect.fail(
                        new RpcError({
                          method,
                          message: err instanceof Error ? err.message : String(err),
                        }),
                      ),
                    ),
                });
                try {
                  socket.write(
                    serializeRpcMessage({
                      type: 'request',
                      id: requestId,
                      method,
                      params,
                    }),
                  );
                } catch (err) {
                  state.pendingHostResponses.delete(requestId);
                  cb(
                    Effect.fail(
                      new RpcError({
                        method,
                        message: `Socket write failed: ${err instanceof Error ? err.message : String(err)}`,
                      }),
                    ),
                  );
                }
              }),
            notify: (method, params) =>
              Effect.sync(() => {
                try {
                  socket.write(
                    serializeRpcMessage({ type: 'event', method, params }),
                  );
                } catch {
                  // Best effort
                }
              }),
          };

          const handleRequest = (msg: RpcRequestMessage): void => {
            if (msg.method !== 'run_query') {
              socket.write(
                serializeRpcMessage({
                  type: 'response',
                  id: msg.id,
                  error: `Unknown method: ${msg.method}`,
                }),
              );
              return;
            }

            if (state.running || queryInFlight) {
              socket.write(
                serializeRpcMessage({
                  type: 'response',
                  id: msg.id,
                  error: 'Agent is busy processing another request',
                }),
              );
              return;
            }

            state.running = true;
            queryInFlight = true;

            void (async () => {
              try {
                const result = await handler(msg.params, bridge);
                socket.write(
                  serializeRpcMessage({
                    type: 'response',
                    id: msg.id,
                    result,
                  }),
                );
              } catch (err) {
                socket.write(
                  serializeRpcMessage({
                    type: 'response',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              } finally {
                state.running = false;
                queryInFlight = false;
                updateHeartbeat();
              }
            })();
          };

          socket.on('data', (chunk) => {
            const parsed = parseRpcLines(chunk.toString('utf8'), state.buffer);
            state.buffer = parsed.buffer;

            for (const msg of parsed.messages) {
              if (msg.type === 'request') {
                handleRequest(msg);
              } else if (msg.type === 'response') {
                const pending = state.pendingHostResponses.get(msg.id);
                if (!pending) continue;
                state.pendingHostResponses.delete(msg.id);
                if (msg.error) pending.reject(new Error(msg.error));
                else pending.resolve(msg.result);
              }
            }
          });

          socket.on('error', (err) => {
            log(`Socket error: ${err.message}`);
          });

          socket.on('close', () => {
            activeSockets.delete(socket);
            for (const { reject } of state.pendingHostResponses.values()) {
              reject(new Error('Host RPC socket closed'));
            }
            state.pendingHostResponses.clear();
          });
        });

        const updateHeartbeat = (): void => {
          try {
            atomicWriteFileSync(
              HEARTBEAT_FILE,
              JSON.stringify({
                pid: process.pid,
                timestamp: Date.now(),
                iso: new Date().toISOString(),
              }),
            );
          } catch { /* ignore */ }
        };

        server.listen(AGENT_RPC_SOCKET, () => {
          updateHeartbeat();
          const heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL);
          log('Agent ready, accepting RPC requests');

          const shutdown = (signal: string) => {
            log(`Received ${signal}, shutting down`);
            clearInterval(heartbeatTimer);
            for (const s of activeSockets) {
              try { s.destroy(); } catch { /* ignore */ }
            }
            try { server.close(); } catch { /* ignore */ }
            try { if (fs.existsSync(HEARTBEAT_FILE)) fs.unlinkSync(HEARTBEAT_FILE); } catch { /* ignore */ }
            try { if (fs.existsSync(AGENT_RPC_SOCKET)) fs.unlinkSync(AGENT_RPC_SOCKET); } catch { /* ignore */ }
            process.exit(0);
          };

          process.on('SIGTERM', () => shutdown('SIGTERM'));
          process.on('SIGINT', () => shutdown('SIGINT'));
        });

        // Never resolves — server runs forever until signal
      }),
  },
);
