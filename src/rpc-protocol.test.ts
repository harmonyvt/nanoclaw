import { describe, expect, test } from 'bun:test';
import {
  parseRpcLines,
  serializeRpcMessage,
  type RpcMessage,
} from './rpc-protocol.js';

describe('rpc-protocol', () => {
  test('serializes newline-delimited JSON message', () => {
    const msg: RpcMessage = {
      type: 'request',
      id: '1',
      method: 'run_query',
      params: { prompt: 'hi' },
    };
    const wire = serializeRpcMessage(msg);
    expect(wire.endsWith('\n')).toBe(true);
    expect(JSON.parse(wire.trim())).toEqual(msg);
  });

  test('parses complete and partial chunks', () => {
    const first = serializeRpcMessage({
      type: 'event',
      method: 'status.event',
      params: { type: 'thinking' },
    });
    const second = serializeRpcMessage({
      type: 'response',
      id: 'run-1',
      result: { status: 'success', result: 'ok' },
    });

    const combined = first + second;
    const splitAt = combined.length - 7;

    const part1 = parseRpcLines(combined.slice(0, splitAt), '');
    expect(part1.messages.length).toBe(1);
    expect(part1.buffer.length).toBeGreaterThan(0);

    const part2 = parseRpcLines(combined.slice(splitAt), part1.buffer);
    expect(part2.messages.length).toBe(1);
    expect(part2.buffer).toBe('');
  });
});
