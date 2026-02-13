import type { RpcEventMessage, RpcRequestMessage } from './rpc-protocol.js';

export interface HostRpcBridge {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
}

let activeBridge: HostRpcBridge | null = null;

export function getHostRpcBridge(): HostRpcBridge | null {
  return activeBridge;
}

export async function withHostRpcBridge<T>(
  bridge: HostRpcBridge | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = activeBridge;
  activeBridge = bridge;
  try {
    return await fn();
  } finally {
    activeBridge = prev;
  }
}

export function makeHostRequest(
  id: string,
  method: string,
  params?: unknown,
): RpcRequestMessage {
  return {
    type: 'request',
    id,
    method,
    params,
  };
}

export function makeHostEvent(
  method: string,
  params?: unknown,
): RpcEventMessage {
  return {
    type: 'event',
    method,
    params,
  };
}
