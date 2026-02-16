/**
 * Lightweight newline-delimited RPC protocol.
 * Custom wire format (NOT JSON-RPC). Messages are JSON objects written
 * one-per-line over a Unix domain socket.
 */

import type { RpcMessage } from '../schemas/RpcProtocol.js';

export function serializeRpcMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function parseRpcLines(
  chunk: string,
  buffer: string,
): { messages: RpcMessage[]; buffer: string } {
  const messages: RpcMessage[] = [];
  const data = buffer + chunk;
  const lines = data.split('\n');
  const nextBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as RpcMessage);
    } catch {
      // Ignore malformed line; transport should continue for subsequent messages.
    }
  }

  return { messages, buffer: nextBuffer };
}
