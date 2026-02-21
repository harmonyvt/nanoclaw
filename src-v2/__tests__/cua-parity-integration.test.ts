import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { describe, expect, it } from 'bun:test';
import { Effect, Fiber, Layer } from 'effect';

import { AppConfig, type AppConfigShape } from '../config.js';
import { BrowseError } from '../errors.js';
import {
  AgentSemaphoreTest,
  AppConfigTest,
  ContainerRunnerTest,
  CredentialsTest,
  DatabaseTest,
  DockerTest,
  GroupRegistryTest,
  MediaTest,
  SandboxTest,
  SchedulerTest,
  SupermemoryTest,
  TTSTest,
  TelegramTest,
  TestAppConfig,
} from '../layers/Test.js';
import { createGroupCoordinator } from '../coordinators/GroupCoordinator.js';
import { startIpcWatcher } from '../coordinators/IpcWatcher.js';
import { BrowseHost, type BrowseHostService } from '../services/BrowseHost.js';
import { BrowseHostLive } from '../services/BrowseHostLive.js';
import { ContainerRunner, type ContainerRunnerService } from '../services/ContainerRunner.js';
import { CuaControl, type CuaControlService } from '../services/CuaControl.js';
import { CuaControlLive } from '../services/CuaControlLive.js';
import { DashboardSession } from '../services/DashboardSession.js';
import { DashboardSessionLive } from '../services/DashboardSessionLive.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { Sandbox, type SandboxConnection, type SandboxService } from '../services/Sandbox.js';
import { TakeoverWeb, type TakeoverWaitHandlers } from '../services/TakeoverWeb.js';
import { TakeoverWebLive } from '../services/TakeoverWebLive.js';
import { Telegram, type TelegramService } from '../services/Telegram.js';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jm2sAAAAASUVORK5CYII=';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(overrides: Partial<AppConfigShape> = {}): AppConfigShape {
  return {
    ...TestAppConfig,
    ...overrides,
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Failed to allocate free port')));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

describe('CUA Control (v2)', () => {
  it('normalizes aliases and filters unknown params', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        requestBodies.push((await req.json()) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ status: 'ok', content: 'ok' }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      const conn: SandboxConnection = {
        containerName: 'test-cua',
        commandUrl: `http://127.0.0.1:${server.port}/cmd`,
        vncPort: 5901,
        novncPort: 6901,
      };

      const sandboxLayer = Layer.succeed(Sandbox, {
        acquire: Effect.succeed(conn),
        ensure: Effect.succeed(conn),
        resetIdle: Effect.void,
        getVncPassword: Effect.succeed(null),
        rotateVncPassword: Effect.succeed(null),
        reset: Effect.void,
        resetFull: Effect.void,
        startIdleWatcher: Effect.void,
      } satisfies SandboxService);

      const program = Effect.gen(function* () {
        const cua = yield* CuaControl;
        yield* cua.command('type', { text: 'hello', extra: 'drop-me' });
        yield* cua.command('exec', { cmd: 'echo hi', extra: 'drop-me' });
      });

      await Effect.runPromise(
        program.pipe(Effect.provide(CuaControlLive.pipe(Layer.provide(sandboxLayer)))),
      );
    } finally {
      server.stop(true);
    }

    expect(requestBodies.length).toBe(2);
    expect(requestBodies[0].command).toBe('type_text');
    expect((requestBodies[0].params as Record<string, unknown>).text).toBe('hello');
    expect((requestBodies[0].params as Record<string, unknown>).extra).toBeUndefined();

    expect(requestBodies[1].command).toBe('run_command');
    expect((requestBodies[1].params as Record<string, unknown>).command).toBe('echo hi');
    expect((requestBodies[1].params as Record<string, unknown>).cmd).toBeUndefined();
    expect((requestBodies[1].params as Record<string, unknown>).extra).toBeUndefined();
  });

  it('decodes image and SSE payloads', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        const command = String(body.command || '');
        if (command === 'screenshot') {
          return new Response(Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'), {
            headers: { 'content-type': 'image/png' },
          });
        }
        return new Response('data: {"result":{"ok":true}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    try {
      const conn: SandboxConnection = {
        containerName: 'test-cua',
        commandUrl: `http://127.0.0.1:${server.port}/cmd`,
        vncPort: 5901,
        novncPort: 6901,
      };
      const sandboxLayer = Layer.succeed(Sandbox, {
        acquire: Effect.succeed(conn),
        ensure: Effect.succeed(conn),
        resetIdle: Effect.void,
        getVncPassword: Effect.succeed(null),
        rotateVncPassword: Effect.succeed(null),
        reset: Effect.void,
        resetFull: Effect.void,
        startIdleWatcher: Effect.void,
      } satisfies SandboxService);

      const program = Effect.gen(function* () {
        const cua = yield* CuaControl;
        const screenshot = yield* cua.command('screenshot');
        const sse = yield* cua.command('version');
        return { screenshot, sse };
      });

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(CuaControlLive.pipe(Layer.provide(sandboxLayer)))),
      );
      expect(typeof result.screenshot).toBe('string');
      expect(String(result.screenshot)).toContain('data:image/png;base64,');
      expect(result.sse).toEqual({ ok: true });
    } finally {
      server.stop(true);
    }
  });

  it('maps command status errors into BrowseError', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({ status: 'error', error: 'simulated command failure' }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });

    try {
      const conn: SandboxConnection = {
        containerName: 'test-cua',
        commandUrl: `http://127.0.0.1:${server.port}/cmd`,
        vncPort: 5901,
        novncPort: 6901,
      };
      const sandboxLayer = Layer.succeed(Sandbox, {
        acquire: Effect.succeed(conn),
        ensure: Effect.succeed(conn),
        resetIdle: Effect.void,
        getVncPassword: Effect.succeed(null),
        rotateVncPassword: Effect.succeed(null),
        reset: Effect.void,
        resetFull: Effect.void,
        startIdleWatcher: Effect.void,
      } satisfies SandboxService);

      const program = Effect.gen(function* () {
        const cua = yield* CuaControl;
        return yield* cua.command('version');
      });

      const outcome = await Effect.runPromise(
        Effect.either(
          program.pipe(
            Effect.provide(CuaControlLive.pipe(Layer.provide(sandboxLayer))),
          ),
        ),
      );
      expect(outcome._tag).toBe('Left');
      if (outcome._tag === 'Left') {
        expect(outcome.left.message).toContain('simulated command failure');
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('BrowseHost action parity (v2)', () => {
  it('supports all 15 browse actions with normalized status/result contract', async () => {
    const groupsDir = makeTempDir('nanoclaw-v2-browse-');
    const groupFolder = 'test-group';
    const groupMediaDir = path.join(groupsDir, groupFolder, 'media');
    fs.mkdirSync(groupMediaDir, { recursive: true });
    fs.writeFileSync(path.join(groupMediaDir, 'upload.txt'), 'upload-content');

    const sentMessages: string[] = [];
    const commandLog: string[] = [];
    let waitHandlers: TakeoverWaitHandlers | null = null;

    const configLayer = Layer.succeed(
      AppConfig,
      makeConfig({
        groupsDir,
        dataDir: path.join(groupsDir, 'data'),
      }),
    );

    const sandboxConn: SandboxConnection = {
      containerName: 'test-cua',
      commandUrl: 'http://127.0.0.1:8000/cmd',
      vncPort: 5901,
      novncPort: 6901,
    };

    const sandboxLayer = Layer.succeed(Sandbox, {
      acquire: Effect.succeed(sandboxConn),
      ensure: Effect.succeed(sandboxConn),
      resetIdle: Effect.void,
      getVncPassword: Effect.succeed('pw'),
      rotateVncPassword: Effect.succeed('pw-rotated'),
      reset: Effect.void,
      resetFull: Effect.void,
      startIdleWatcher: Effect.void,
    } satisfies SandboxService);

    const telegramLayer = Layer.succeed(Telegram, {
      connect: Effect.die('not used'),
      sendMessage: (_chatJid, text) =>
        Effect.sync(() => {
          sentMessages.push(text);
        }),
      sendMessageWithId: (_chatJid, _text) => Effect.succeed(1),
      editMessageText: (_chatJid, _messageId, _text) => Effect.succeed(true),
      deleteMessage: (_chatJid, _messageId) => Effect.void,
      sendPhoto: (_chatJid, _path, _caption) => Effect.succeed(1),
      editPhoto: (_chatJid, _messageId, _path, _caption) => Effect.succeed(true),
      sendDocument: (_chatJid, _path, _caption) => Effect.void,
      sendVoice: (_chatJid, _path) => Effect.void,
      sendStatusMessage: (_chatJid, _text) => Effect.succeed(1),
      editStatusMessage: (_chatJid, _messageId, _text) => Effect.succeed(true),
      setTyping: (_chatJid) => Effect.void,
      stop: Effect.void,
    } satisfies TelegramService);

    const accessibilityTree = {
      tree: {
        role: 'root',
        children: [
          {
            role: 'button',
            label: 'Search',
            x: 100,
            y: 120,
            width: 120,
            height: 40,
            interactive: true,
          },
          {
            role: 'textbox',
            label: 'Email',
            value: 'hello@example.com',
            x: 100,
            y: 220,
            width: 220,
            height: 40,
            interactive: true,
          },
        ],
      },
    };

    let uploadChunksWritten = 0;
    const cuaCommand: CuaControlService['command'] = (command, args = {}) =>
      Effect.sync(() => {
        commandLog.push(command);

        if (command === 'get_accessibility_tree') return accessibilityTree;
        if (command === 'find_element') return { x: 140, y: 140 };
        if (command === 'screenshot') {
          return `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`;
        }
        if (command === 'run_command') {
          const shell = String(args.command || '');
          if (shell.includes('xrandr')) return { stdout: '1024x768\n' };
          if (shell.includes("stat -c '%s'")) return { stdout: '4\n' };
          if (shell.includes('base64 -w0')) {
            return { stdout: Buffer.from('file').toString('base64') };
          }
          if (shell.includes('base64 -d')) {
            uploadChunksWritten += 1;
            return { stdout: '' };
          }
          return { stdout: '' };
        }
        return { ok: true };
      });

    const cuaLayer = Layer.succeed(CuaControl, {
      command: cuaCommand,
      commandWithFallback: (attempts) =>
        Effect.gen(function* () {
          const first = attempts[0];
          if (!first) {
            return yield* Effect.fail(
              new BrowseError({
                message: 'No fallback attempts',
                action: 'unknown',
              }),
            );
          }
          return yield* cuaCommand(first.command, first.args || {});
        }),
      isKnownCommand: (_command) => true,
      shellSingleQuote: (value) => `'${value.replace(/'/g, `'"'"'`)}'`,
    } satisfies CuaControlService);

    const dashboardLayer = Layer.succeed(DashboardSession, {
      validateTelegramInitData: (_raw) => Effect.succeed({ valid: true, userId: 12345 }),
      createSession: (_userId, _groupFolder) =>
        Effect.succeed({ token: 'session-token', expiresAt: Date.now() + 60_000 }),
      validateSession: (_token) => Effect.succeed({ userId: 12345 }),
      createSessionForOwner: (_groupFolder) =>
        Effect.succeed({ token: 'session-token', expiresAt: Date.now() + 60_000 }),
      cleanExpiredSessions: Effect.void,
    });

    const takeoverLayer = Layer.succeed(TakeoverWeb, {
      start: Effect.void,
      setWaitHandlers: (handlers) =>
        Effect.sync(() => {
          waitHandlers = handlers;
        }),
      getTakeoverBaseUrl: Effect.succeed('http://127.0.0.1:7788'),
      getTakeoverUrl: (token, sessionToken) =>
        Effect.succeed(
          `http://127.0.0.1:7788/cua/takeover/${token}${
            sessionToken ? `?session=${encodeURIComponent(sessionToken)}` : ''
          }`,
        ),
    });

    const browseLayer = BrowseHostLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          configLayer,
          sandboxLayer,
          telegramLayer,
          cuaLayer,
          dashboardLayer,
          takeoverLayer,
        ),
      ),
    );

    const program = Effect.gen(function* () {
      const browseHost = yield* BrowseHost;

      const actionCases: Array<{ action: string; params: Record<string, unknown> }> = [
        { action: 'navigate', params: { url: 'https://example.com' } },
        { action: 'snapshot', params: {} },
        { action: 'click', params: { selector: 'Search' } },
        { action: 'click_xy', params: { x: 100, y: 200 } },
        { action: 'type_at_xy', params: { x: 110, y: 210, value: 'hello' } },
        { action: 'fill', params: { selector: 'Email', value: 'user@example.com' } },
        { action: 'scroll', params: { direction: 'down', clicks: 2 } },
        { action: 'screenshot', params: {} },
        {
          action: 'perform',
          params: {
            steps: [
              { action: 'click', x: 100, y: 200 },
              { action: 'key', key: 'ctrl+a' },
              { action: 'type', text: 'new value' },
              { action: 'wait', ms: 10 },
            ],
          },
        },
        { action: 'go_back', params: {} },
        { action: 'evaluate', params: { expression: '1+1' } },
        { action: 'close', params: {} },
        { action: 'extract_file', params: { path: '/tmp/report.txt' } },
        {
          action: 'upload_file',
          params: {
            source_path: '/workspace/group/media/upload.txt',
            destination_path: '~/Downloads/upload.txt',
          },
        },
      ];

      const outcomes: Array<{ action: string; status: string }> = [];
      for (const item of actionCases) {
        const res = yield* browseHost.processAction(groupFolder, item.action, item.params);
        outcomes.push({ action: item.action, status: res.status });
      }

      const waitFiber = yield* Effect.fork(
        browseHost.waitForUser('req-1', groupFolder, 'Please solve captcha', 'chat-1'),
      );
      yield* Effect.sleep('30 millis');
      const resolved = yield* browseHost.resolveWait(groupFolder, 'req-1');
      const waitResult = yield* Effect.fromFiber(waitFiber);

      return { outcomes, resolved, waitResult };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(browseLayer)));

    expect(waitHandlers).not.toBeNull();
    expect(result.outcomes.length).toBe(14);
    for (const outcome of result.outcomes) {
      if (outcome.action === 'evaluate') {
        expect(outcome.status).toBe('error');
      } else {
        expect(outcome.status).toBe('ok');
      }
    }
    expect(result.resolved).toBe(true);
    expect(result.waitResult.status).toBe('ok');
    expect(sentMessages.some((m) => m.includes('/cua/takeover/'))).toBe(true);
    expect(sentMessages.some((m) => m.includes('continue req-1'))).toBe(true);
    expect(uploadChunksWritten).toBeGreaterThan(0);
    expect(commandLog.includes('screenshot')).toBe(true);
  });
});

describe('Takeover web auth flow (v2)', () => {
  it('requires session auth and supports continue by takeover token', async () => {
    const port = await getFreePort();
    const appConfig = makeConfig({
      sandboxTailscaleEnabled: false,
      cuaTakeoverWebEnabled: true,
      cuaTakeoverWebPort: port,
      cuaTakeoverHttpsPort: port + 100,
      cuaSandboxNovncPort: port + 1,
      telegramOwnerId: '12345',
    });

    const appConfigLayer = Layer.succeed(AppConfig, appConfig);
    const dashboardLayer = DashboardSessionLive.pipe(Layer.provide(appConfigLayer));
    const takeoverLayer = TakeoverWebLive.pipe(
      Layer.provide(Layer.mergeAll(appConfigLayer, dashboardLayer)),
    );
    const fullLayer = Layer.mergeAll(appConfigLayer, dashboardLayer, takeoverLayer);

    const program = Effect.gen(function* () {
      const dashboard = yield* DashboardSession;
      const takeover = yield* TakeoverWeb;

      const pending = new Map<string, { requestId: string; groupFolder: string; createdAt: string; message: string }>();
      pending.set('token-1', {
        requestId: 'req-1',
        groupFolder: 'main',
        createdAt: new Date().toISOString(),
        message: 'Please confirm login',
      });

      yield* takeover.setWaitHandlers({
        getByToken: (token) => {
          const item = pending.get(token);
          if (!item) return null;
          return {
            requestId: item.requestId,
            groupFolder: item.groupFolder,
            token,
            createdAt: item.createdAt,
            message: item.message,
            vncPassword: 'pw',
          };
        },
        resolveByToken: (token) => pending.delete(token),
      });

      yield* takeover.start;
      const baseUrl = yield* takeover.getTakeoverBaseUrl;
      expect(baseUrl).not.toBeNull();
      const base = String(baseUrl);

      const unauthorizedRes = yield* Effect.tryPromise(() =>
        fetch(`${base}/api/cua/takeover/token-1`),
      );
      expect(unauthorizedRes.status).toBe(401);

      const ownerSession = yield* dashboard.createSessionForOwner('main');
      expect(ownerSession).not.toBeNull();
      const sessionToken = ownerSession!.token;

      const authorizedRes = yield* Effect.tryPromise(() =>
        fetch(`${base}/api/cua/takeover/token-1?session=${encodeURIComponent(sessionToken)}`),
      );
      expect(authorizedRes.status).toBe(200);
      const authorizedBody = (yield* Effect.tryPromise(
        () => authorizedRes.json() as Promise<Record<string, unknown>>,
      ));
      expect(authorizedBody.status).toBe('pending');
      expect(authorizedBody.requestId).toBe('req-1');

      const pageRes = yield* Effect.tryPromise(() =>
        fetch(`${base}/cua/takeover/token-1?session=${encodeURIComponent(sessionToken)}`),
      );
      expect(pageRes.status).toBe(200);

      const continueRes = yield* Effect.tryPromise(() =>
        fetch(
          `${base}/api/cua/takeover/token-1/continue?session=${encodeURIComponent(sessionToken)}`,
          { method: 'POST' },
        ),
      );
      expect(continueRes.status).toBe(200);
      const continueBody = (yield* Effect.tryPromise(
        () => continueRes.json() as Promise<Record<string, unknown>>,
      ));
      expect(continueBody.status).toBe('ok');
      expect(pending.has('token-1')).toBe(false);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(fullLayer), Effect.scoped),
    );
  });
});

describe('GroupCoordinator browse RPC path (v2)', () => {
  it('routes browse.handle to BrowseHost and keeps unknown methods as null', async () => {
    const rpcResults: unknown[] = [];

    const browseHostLayer = Layer.succeed(BrowseHost, {
      processAction: (_sourceGroup, action, _params) =>
        Effect.succeed({
          status: 'ok',
          result: `handled:${action}`,
        }),
      waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
        Effect.succeed({
          status: 'ok',
          result: 'wait complete',
        }),
      resolveWait: (_groupFolder, _requestId?) => Effect.succeed(true),
      resolveWaitByToken: (_token) => Effect.succeed(true),
      getWaitByToken: (_token) => Effect.succeed(null),
      cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
      hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
    } satisfies BrowseHostService);

    const containerRunnerLayer = Layer.succeed(ContainerRunner, {
      runAgent: (_input, handlers) =>
        Effect.gen(function* () {
          if (handlers.onRequest) {
            const snapshotResult = yield* Effect.tryPromise({
              try: () =>
                handlers.onRequest!({
                  method: 'browse.handle',
                  params: { action: 'snapshot', params: {} },
                }),
              catch: (error) => new Error(String(error)),
            }).pipe(Effect.orDie);
            rpcResults.push(snapshotResult);

            const waitResult = yield* Effect.tryPromise({
              try: () =>
                handlers.onRequest!({
                  method: 'browse.handle',
                  params: {
                    action: 'wait_for_user',
                    params: { message: 'Need user confirmation' },
                  },
                }),
              catch: (error) => new Error(String(error)),
            }).pipe(Effect.orDie);
            rpcResults.push(waitResult);

            const unknownResult = yield* Effect.tryPromise({
              try: () =>
                handlers.onRequest!({
                  method: 'tools.unknown',
                  params: {},
                }),
              catch: (error) => new Error(String(error)),
            }).pipe(Effect.orDie);
            rpcResults.push(unknownResult);
          }

          return {
            status: 'success' as const,
            result: 'ok',
          };
        }),
      interrupt: (_groupFolder) => Effect.succeed({ interrupted: true as const }),
      hasActiveRequest: (_groupFolder) => Effect.succeed(false),
      killAll: Effect.void,
      ensureImage: Effect.void,
      cleanupOrphans: Effect.void,
    } satisfies ContainerRunnerService);

    const layer = Layer.mergeAll(
      AppConfigTest,
      DatabaseTest,
      DockerTest,
      CredentialsTest,
      TelegramTest,
      containerRunnerLayer,
      GroupRegistryTest,
      SchedulerTest,
      SandboxTest,
      browseHostLayer,
      TTSTest,
      SupermemoryTest,
      MediaTest,
      AgentSemaphoreTest,
    );

    const program = Effect.gen(function* () {
      const registry = yield* GroupRegistry;
      yield* registry.register('chat-rpc', {
        name: 'RPC Group',
        folder: 'rpc-group',
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const coordinator = yield* createGroupCoordinator('chat-rpc', {
        name: 'RPC Group',
        folder: 'rpc-group',
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      yield* coordinator.queue.offer({
        id: 'msg-rpc-1',
        chatJid: 'chat-rpc',
        sender: 'user',
        senderName: 'User',
        content: 'run browse tool',
        timestamp: new Date().toISOString(),
      });

      const fiber = yield* Effect.fork(coordinator.loop);
      yield* Effect.sleep('500 millis');
      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(rpcResults.length).toBe(3);
    expect(rpcResults[0]).toMatchObject({ status: 'ok', result: 'handled:snapshot' });
    expect(rpcResults[1]).toMatchObject({ status: 'ok', result: 'wait complete' });
    expect(rpcResults[2]).toBeNull();
  });
});

describe('IPC browse response shape (v2)', () => {
  it('writes status/result for successful browse requests', async () => {
    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      const registry = yield* GroupRegistry;
      const groupFolder = `ipc-success-${Date.now()}`;
      const chatJid = `chat-${groupFolder}`;

      yield* registry.register(chatJid, {
        name: 'IPC Success Group',
        folder: groupFolder,
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const browseDir = path.join(config.dataDir, 'ipc', groupFolder, 'browse');
      fs.rmSync(browseDir, { recursive: true, force: true });
      fs.mkdirSync(browseDir, { recursive: true });

      const reqId = 'req-success';
      fs.writeFileSync(
        path.join(browseDir, `req-${reqId}.json`),
        JSON.stringify({ action: 'snapshot', params: {} }),
      );

      const watcherFiber = yield* Effect.fork(startIpcWatcher);
      yield* Effect.sleep('1300 millis');
      yield* Fiber.interrupt(watcherFiber);

      const resPath = path.join(browseDir, `res-${reqId}.json`);
      expect(fs.existsSync(resPath)).toBe(true);
      return JSON.parse(fs.readFileSync(resPath, 'utf-8')) as Record<string, unknown>;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(
      AppConfigTest,
      DatabaseTest,
      TelegramTest,
      GroupRegistryTest,
      Layer.succeed(BrowseHost, {
        processAction: (_sourceGroup, action, _params) =>
          Effect.succeed({ status: 'ok', result: `ok:${action}` }),
        waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
          Effect.succeed({ status: 'ok', result: 'waited' }),
        resolveWait: (_groupFolder, _requestId?) => Effect.succeed(true),
        resolveWaitByToken: (_token) => Effect.succeed(true),
        getWaitByToken: (_token) => Effect.succeed(null),
        cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
        hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
      } satisfies BrowseHostService),
    ))));

    expect(result.status).toBe('ok');
    expect(result.result).toBe('ok:snapshot');
  });

  it('writes status/error when browse action fails', async () => {
    const failingBrowseHost = Layer.succeed(BrowseHost, {
      processAction: (_sourceGroup, action, _params) =>
        Effect.fail(
          new BrowseError({
            message: `boom:${action}`,
            action,
          }),
        ),
      waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
        Effect.fail(
          new BrowseError({
            message: 'wait failed',
            action: 'wait_for_user',
          }),
        ),
      resolveWait: (_groupFolder, _requestId?) => Effect.succeed(false),
      resolveWaitByToken: (_token) => Effect.succeed(false),
      getWaitByToken: (_token) => Effect.succeed(null),
      cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
      hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
    } satisfies BrowseHostService);

    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      const registry = yield* GroupRegistry;
      const groupFolder = `ipc-error-${Date.now()}`;
      const chatJid = `chat-${groupFolder}`;

      yield* registry.register(chatJid, {
        name: 'IPC Error Group',
        folder: groupFolder,
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const browseDir = path.join(config.dataDir, 'ipc', groupFolder, 'browse');
      fs.rmSync(browseDir, { recursive: true, force: true });
      fs.mkdirSync(browseDir, { recursive: true });

      const reqId = 'req-error';
      fs.writeFileSync(
        path.join(browseDir, `req-${reqId}.json`),
        JSON.stringify({ action: 'snapshot', params: {} }),
      );

      const watcherFiber = yield* Effect.fork(startIpcWatcher);
      yield* Effect.sleep('1300 millis');
      yield* Fiber.interrupt(watcherFiber);

      const resPath = path.join(browseDir, `res-${reqId}.json`);
      expect(fs.existsSync(resPath)).toBe(true);
      return JSON.parse(fs.readFileSync(resPath, 'utf-8')) as Record<string, unknown>;
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            AppConfigTest,
            DatabaseTest,
            TelegramTest,
            GroupRegistryTest,
            failingBrowseHost,
          ),
        ),
      ),
    );

    expect(result.status).toBe('error');
    expect(String(result.error || '')).toContain('boom:snapshot');
  });

  it('keeps consuming message IPC files while a browse action is stuck', async () => {
    const sentMessages: Array<{ chatJid: string; text: string }> = [];

    const telegramLayer = Layer.succeed(Telegram, {
      connect: Effect.die('not used'),
      sendMessage: (chatJid, text) =>
        Effect.sync(() => {
          sentMessages.push({ chatJid, text });
        }),
      sendMessageWithId: (_chatJid, _text) => Effect.succeed(1),
      editMessageText: (_chatJid, _messageId, _text) => Effect.succeed(true),
      deleteMessage: (_chatJid, _messageId) => Effect.void,
      sendPhoto: (_chatJid, _path, _caption) => Effect.succeed(1),
      editPhoto: (_chatJid, _messageId, _path, _caption) => Effect.succeed(true),
      sendDocument: (_chatJid, _path, _caption) => Effect.void,
      sendVoice: (_chatJid, _path) => Effect.void,
      sendStatusMessage: (_chatJid, _text) => Effect.succeed(1),
      editStatusMessage: (_chatJid, _messageId, _text) => Effect.succeed(true),
      setTyping: (_chatJid) => Effect.void,
      stop: Effect.void,
    } satisfies TelegramService);

    const stuckBrowseHost = Layer.succeed(BrowseHost, {
      processAction: (_sourceGroup, _action, _params) => Effect.never,
      waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
        Effect.succeed({ status: 'ok', result: 'waited' }),
      resolveWait: (_groupFolder, _requestId?) => Effect.succeed(false),
      resolveWaitByToken: (_token) => Effect.succeed(false),
      getWaitByToken: (_token) => Effect.succeed(null),
      cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
      hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
    } satisfies BrowseHostService);

    const configLayer = Layer.succeed(
      AppConfig,
      makeConfig({
        ipcBrowseActionTimeoutMs: 10_000,
      }),
    );

    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      const registry = yield* GroupRegistry;
      const groupFolder = `ipc-stuck-${Date.now()}`;
      const chatJid = `chat-${groupFolder}`;

      yield* registry.register(chatJid, {
        name: 'IPC Stuck Group',
        folder: groupFolder,
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const ipcGroupDir = path.join(config.dataDir, 'ipc', groupFolder);
      const browseDir = path.join(ipcGroupDir, 'browse');
      const messagesDir = path.join(ipcGroupDir, 'messages');
      fs.rmSync(ipcGroupDir, { recursive: true, force: true });
      fs.mkdirSync(browseDir, { recursive: true });
      fs.mkdirSync(messagesDir, { recursive: true });

      fs.writeFileSync(
        path.join(browseDir, 'req-stuck.json'),
        JSON.stringify({ action: 'snapshot', params: {} }),
      );

      const watcherFiber = yield* Effect.fork(startIpcWatcher);
      yield* Effect.sleep('1300 millis');

      const msgPath = path.join(messagesDir, 'msg-after-stuck.json');
      fs.writeFileSync(
        msgPath,
        JSON.stringify({
          chatJid,
          text: 'hello from IPC',
        }),
      );

      yield* Effect.sleep('1300 millis');
      yield* Fiber.interrupt(watcherFiber);

      return { msgPath, chatJid };
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            configLayer,
            DatabaseTest,
            telegramLayer,
            GroupRegistryTest,
            stuckBrowseHost,
          ),
        ),
      ),
    );

    expect(fs.existsSync(result.msgPath)).toBe(false);
    expect(sentMessages.some((m) => m.chatJid === result.chatJid && m.text === 'hello from IPC')).toBe(true);
  });

  it('writes wait_for_user IPC responses after token and chat continue even if auto-screenshot hangs', async () => {
    const sentMessages: Array<{ chatJid: string; text: string }> = [];
    const rootDir = makeTempDir('nanoclaw-v2-ipc-wait-');
    const groupsDir = path.join(rootDir, 'groups');
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const configLayer = Layer.succeed(
      AppConfig,
      makeConfig({
        projectRoot: rootDir,
        storeDir: path.join(rootDir, 'store'),
        groupsDir,
        dataDir,
        serviceLogsDir: path.join(rootDir, 'logs', 'services'),
      }),
    );

    const sandboxConn: SandboxConnection = {
      containerName: 'test-cua',
      commandUrl: 'http://127.0.0.1:8000/cmd',
      vncPort: 5901,
      novncPort: 6901,
    };

    const sandboxLayer = Layer.succeed(Sandbox, {
      acquire: Effect.succeed(sandboxConn),
      ensure: Effect.succeed(sandboxConn),
      resetIdle: Effect.void,
      getVncPassword: Effect.succeed('pw'),
      rotateVncPassword: Effect.succeed('pw-rotated'),
      reset: Effect.void,
      resetFull: Effect.void,
      startIdleWatcher: Effect.void,
    } satisfies SandboxService);

    const telegramLayer = Layer.succeed(Telegram, {
      connect: Effect.die('not used'),
      sendMessage: (chatJid, text) =>
        Effect.sync(() => {
          sentMessages.push({ chatJid, text });
        }),
      sendMessageWithId: (_chatJid, _text) => Effect.succeed(1),
      editMessageText: (_chatJid, _messageId, _text) => Effect.succeed(true),
      deleteMessage: (_chatJid, _messageId) => Effect.void,
      sendPhoto: (_chatJid, _path, _caption) => Effect.succeed(1),
      editPhoto: (_chatJid, _messageId, _path, _caption) => Effect.succeed(true),
      sendDocument: (_chatJid, _path, _caption) => Effect.void,
      sendVoice: (_chatJid, _path) => Effect.void,
      sendStatusMessage: (_chatJid, _text) => Effect.succeed(1),
      editStatusMessage: (_chatJid, _messageId, _text) => Effect.succeed(true),
      setTyping: (_chatJid) => Effect.void,
      stop: Effect.void,
    } satisfies TelegramService);

    const cuaLayer = Layer.succeed(CuaControl, {
      command: (command, _args = {}) =>
        command === 'screenshot'
          ? Effect.never
          : Effect.succeed({ ok: true }),
      commandWithFallback: (attempts) =>
        Effect.gen(function* () {
          const first = attempts[0];
          if (!first) {
            return yield* Effect.fail(
              new BrowseError({
                message: 'No fallback attempts',
                action: 'unknown',
              }),
            );
          }
          return yield* (first.command === 'screenshot'
            ? Effect.never
            : Effect.succeed({ ok: true }));
        }),
      isKnownCommand: (_command) => true,
      shellSingleQuote: (value) => `'${value.replace(/'/g, `'"'"'`)}'`,
    } satisfies CuaControlService);

    const dashboardLayer = Layer.succeed(DashboardSession, {
      validateTelegramInitData: (_raw) => Effect.succeed({ valid: true, userId: 12345 }),
      createSession: (_userId, _groupFolder) =>
        Effect.succeed({ token: 'session-token', expiresAt: Date.now() + 60_000 }),
      validateSession: (_token) => Effect.succeed({ userId: 12345 }),
      createSessionForOwner: (_groupFolder) =>
        Effect.succeed({ token: 'session-token', expiresAt: Date.now() + 60_000 }),
      cleanExpiredSessions: Effect.void,
    });

    const takeoverLayer = Layer.succeed(TakeoverWeb, {
      start: Effect.void,
      setWaitHandlers: (_handlers) => Effect.void,
      getTakeoverBaseUrl: Effect.succeed('http://127.0.0.1:7788'),
      getTakeoverUrl: (token, sessionToken) =>
        Effect.succeed(
          `http://127.0.0.1:7788/cua/takeover/${token}${
            sessionToken ? `?session=${encodeURIComponent(sessionToken)}` : ''
          }`,
        ),
    });

    const browseLayer = BrowseHostLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          configLayer,
          sandboxLayer,
          telegramLayer,
          cuaLayer,
          dashboardLayer,
          takeoverLayer,
        ),
      ),
    );

    const layer = Layer.mergeAll(
      configLayer,
      DatabaseTest,
      telegramLayer,
      GroupRegistryTest,
      browseLayer,
    );

    const extractTokenForRequest = (requestId: string): string | null => {
      for (const message of [...sentMessages].reverse()) {
        if (!message.text.includes(`Request ID: ${requestId}`)) continue;
        const match = message.text.match(/\/cua\/takeover\/([^?\s]+)/);
        if (match?.[1]) return match[1];
      }
      return null;
    };

    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      const registry = yield* GroupRegistry;
      const browseHost = yield* BrowseHost;

      const groupFolder = `ipc-wait-${Date.now()}`;
      const chatJid = `chat-${groupFolder}`;
      yield* registry.register(chatJid, {
        name: 'IPC Wait Group',
        folder: groupFolder,
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const browseDir = path.join(config.dataDir, 'ipc', groupFolder, 'browse');
      fs.rmSync(browseDir, { recursive: true, force: true });
      fs.mkdirSync(browseDir, { recursive: true });

      const waitForResponse = (reqId: string) =>
        Effect.gen(function* () {
          const resPath = path.join(browseDir, `res-${reqId}.json`);
          for (let i = 0; i < 120; i++) {
            if (fs.existsSync(resPath)) {
              return JSON.parse(
                fs.readFileSync(resPath, 'utf-8'),
              ) as Record<string, unknown>;
            }
            yield* Effect.sleep('100 millis');
          }
          return null as Record<string, unknown> | null;
        });

      const watcherFiber = yield* Effect.fork(startIpcWatcher);

      const reqByToken = 'req-token';
      fs.writeFileSync(
        path.join(browseDir, `req-${reqByToken}.json`),
        JSON.stringify({
          action: 'wait_for_user',
          params: { message: 'Token continue path' },
        }),
      );

      let takeoverToken: string | null = null;
      for (let i = 0; i < 120; i++) {
        takeoverToken = extractTokenForRequest(reqByToken);
        if (takeoverToken) break;
        yield* Effect.sleep('100 millis');
      }

      const resolvedByToken = takeoverToken
        ? yield* browseHost.resolveWaitByToken(takeoverToken)
        : false;
      const tokenResponse = yield* waitForResponse(reqByToken);

      const reqByChat = 'req-chat';
      fs.writeFileSync(
        path.join(browseDir, `req-${reqByChat}.json`),
        JSON.stringify({
          action: 'wait_for_user',
          params: { message: 'Chat continue path' },
        }),
      );

      let resolvedByChat = false;
      for (let i = 0; i < 120; i++) {
        resolvedByChat = yield* browseHost.resolveWait(groupFolder, reqByChat);
        if (resolvedByChat) break;
        yield* Effect.sleep('100 millis');
      }

      const chatResponse = yield* waitForResponse(reqByChat);
      yield* Fiber.interrupt(watcherFiber);

      return {
        takeoverToken,
        resolvedByToken,
        tokenResponse,
        resolvedByChat,
        chatResponse,
      };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(result.takeoverToken).not.toBeNull();
    expect(result.resolvedByToken).toBe(true);
    expect(result.tokenResponse?.status).toBe('ok');

    expect(result.resolvedByChat).toBe(true);
    expect(result.chatResponse?.status).toBe('ok');
  }, 20_000);

  it('writes status/error when browse action times out', async () => {
    const timeoutBrowseHost = Layer.succeed(BrowseHost, {
      processAction: (_sourceGroup, _action, _params) => Effect.never,
      waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
        Effect.succeed({ status: 'ok', result: 'waited' }),
      resolveWait: (_groupFolder, _requestId?) => Effect.succeed(false),
      resolveWaitByToken: (_token) => Effect.succeed(false),
      getWaitByToken: (_token) => Effect.succeed(null),
      cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
      hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
    } satisfies BrowseHostService);

    const configLayer = Layer.succeed(
      AppConfig,
      makeConfig({
        ipcBrowseActionTimeoutMs: 250,
      }),
    );

    const program = Effect.gen(function* () {
      const config = yield* AppConfig;
      const registry = yield* GroupRegistry;
      const groupFolder = `ipc-timeout-${Date.now()}`;
      const chatJid = `chat-${groupFolder}`;

      yield* registry.register(chatJid, {
        name: 'IPC Timeout Group',
        folder: groupFolder,
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const browseDir = path.join(config.dataDir, 'ipc', groupFolder, 'browse');
      fs.rmSync(browseDir, { recursive: true, force: true });
      fs.mkdirSync(browseDir, { recursive: true });

      const reqId = 'req-timeout';
      fs.writeFileSync(
        path.join(browseDir, `req-${reqId}.json`),
        JSON.stringify({ action: 'snapshot', params: {} }),
      );

      const watcherFiber = yield* Effect.fork(startIpcWatcher);
      yield* Effect.sleep('1700 millis');
      yield* Fiber.interrupt(watcherFiber);

      const resPath = path.join(browseDir, `res-${reqId}.json`);
      expect(fs.existsSync(resPath)).toBe(true);
      return JSON.parse(fs.readFileSync(resPath, 'utf-8')) as Record<string, unknown>;
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            configLayer,
            DatabaseTest,
            TelegramTest,
            GroupRegistryTest,
            timeoutBrowseHost,
          ),
        ),
      ),
    );

    expect(result.status).toBe('error');
    expect(String(result.error || '')).toContain('timed out');
  });
});
