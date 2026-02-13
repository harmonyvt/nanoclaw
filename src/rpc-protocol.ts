/**
 * Lightweight newline-delimited RPC protocol used between host and container.
 * Messages are JSON objects written one-per-line over a Unix domain socket.
 */

export interface RpcRequestMessage {
  type: 'request';
  id: string;
  method: string;
  params?: unknown;
}

export interface RpcResponseMessage {
  type: 'response';
  id: string;
  result?: unknown;
  error?: string;
}

export interface RpcEventMessage {
  type: 'event';
  method: string;
  params?: unknown;
}

export type RpcMessage =
  | RpcRequestMessage
  | RpcResponseMessage
  | RpcEventMessage;

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
      // Ignore malformed line; keep stream alive for subsequent messages.
    }
  }

  return { messages, buffer: nextBuffer };
}
