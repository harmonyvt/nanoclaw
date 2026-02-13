import { describe, expect, test } from 'bun:test';
import {
  routeHostRpcEvent,
  routeHostRpcRequest,
  type HostRpcRouterDeps,
} from './host-rpc-router.js';

function makeDeps(overrides?: Partial<HostRpcRouterDeps>): HostRpcRouterDeps {
  return {
    mainGroupFolder: 'main',
    groupFolderForChatJid: (chatJid: string) =>
      chatJid === 'tg:group-a' ? 'group-a' : undefined,
    sendMessage: async () => {},
    sendVoice: async () => 'Voice sent.',
    sendFile: async () => 'File sent.',
    handleTaskAction: async () => 'Task action handled.',
    handleBrowseAction: async () => ({ status: 'ok', result: 'done' }),
    processStatusEvents: async () => {},
    ...overrides,
  };
}

describe('routeHostRpcRequest', () => {
  test('routes telegram.sendMessage when authorized', async () => {
    const calls: string[] = [];
    const result = await routeHostRpcRequest(
      'group-a',
      {
        method: 'telegram.sendMessage',
        params: { chatJid: 'tg:group-a', text: 'hello' },
      },
      makeDeps({
        sendMessage: async (chatJid, text, sourceGroup) => {
          calls.push(`${sourceGroup}:${chatJid}:${text}`);
        },
      }),
    );

    expect(result).toEqual({ ok: true, message: 'Message sent.' });
    expect(calls).toEqual(['group-a:tg:group-a:hello']);
  });

  test('rejects telegram.sendMessage when unauthorized', async () => {
    await expect(
      routeHostRpcRequest(
        'group-a',
        {
          method: 'telegram.sendMessage',
          params: { chatJid: 'tg:other', text: 'hello' },
        },
        makeDeps(),
      ),
    ).rejects.toThrow('Unauthorized message send attempt');
  });

  test('routes telegram.sendVoice and returns provider message', async () => {
    const result = await routeHostRpcRequest(
      'group-a',
      {
        method: 'telegram.sendVoice',
        params: { chatJid: 'tg:group-a', text: 'hi', emotion: 'happy' },
      },
      makeDeps({
        sendVoice: async ({ emotion }) => `Voice sent (${emotion}).`,
      }),
    );

    expect(result).toEqual({ ok: true, message: 'Voice sent (happy).' });
  });

  test('routes telegram.sendFile and returns provider message', async () => {
    const result = await routeHostRpcRequest(
      'main',
      {
        method: 'telegram.sendFile',
        params: { chatJid: 'tg:any', filePath: '/workspace/group/report.txt' },
      },
      makeDeps({
        sendFile: async ({ filePath }) => `File sent: ${filePath}`,
      }),
    );

    expect(result).toEqual({
      ok: true,
      message: 'File sent: /workspace/group/report.txt',
    });
  });

  test('routes tasks.handle with isMain=false', async () => {
    let receivedIsMain = true;
    const result = await routeHostRpcRequest(
      'group-a',
      {
        method: 'tasks.handle',
        params: { type: 'schedule_task' },
      },
      makeDeps({
        handleTaskAction: async (_payload, _sourceGroup, isMain) => {
          receivedIsMain = isMain;
          return 'Task action handled.';
        },
      }),
    );

    expect(receivedIsMain).toBe(false);
    expect(result).toEqual({ ok: true, message: 'Task action handled.' });
  });

  test('routes browse.handle', async () => {
    const result = await routeHostRpcRequest(
      'group-a',
      {
        method: 'browse.handle',
        params: { action: 'snapshot', params: { deep: true } },
      },
      makeDeps({
        handleBrowseAction: async (_sourceGroup, action, params) => ({
          status: 'ok',
          result: `${action}:${String(params.deep)}`,
        }),
      }),
    );

    expect(result).toEqual({ status: 'ok', result: 'snapshot:true' });
  });
});

describe('routeHostRpcEvent', () => {
  test('routes status.event payload to processStatusEvents', async () => {
    const events: unknown[][] = [];
    await routeHostRpcEvent(
      'group-a',
      {
        method: 'status.event',
        params: { type: 'thinking', content: 'step' },
      },
      makeDeps({
        processStatusEvents: async (_sourceGroup, e) => {
          events.push(e);
        },
      }),
    );

    expect(events.length).toBe(1);
    expect(events[0]).toEqual([{ type: 'thinking', content: 'step' }]);
  });

  test('ignores non-status events', async () => {
    let called = false;
    await routeHostRpcEvent(
      'group-a',
      { method: 'other.event', params: { ok: true } },
      makeDeps({
        processStatusEvents: async () => {
          called = true;
        },
      }),
    );
    expect(called).toBe(false);
  });
});
