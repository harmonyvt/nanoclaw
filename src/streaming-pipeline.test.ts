import { describe, test, expect, beforeEach } from 'bun:test';
import {
  isPipelineEvent,
  humanizeToolName,
  TOOL_DISPLAY_NAMES,
  StreamingMessagePipeline,
  type TelegramOps,
  type PipelineConfig,
  type PipelineEvent,
} from './streaming-pipeline.js';

// ─── Mock Factories ─────────────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: unknown[];
}

function makeMockTelegram(
  overrides: Partial<TelegramOps> = {},
): TelegramOps & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    sendStatusMessage: async (chatJid, text) => {
      calls.push({ method: 'sendStatusMessage', args: [chatJid, text] });
      return 1;
    },
    editStatusMessage: async (chatJid, msgId, text) => {
      calls.push({ method: 'editStatusMessage', args: [chatJid, msgId, text] });
      return true;
    },
    sendMessageWithId: async (chatJid, text) => {
      calls.push({ method: 'sendMessageWithId', args: [chatJid, text] });
      return 2;
    },
    editMessageText: async (chatJid, msgId, text) => {
      calls.push({ method: 'editMessageText', args: [chatJid, msgId, text] });
      return true;
    },
    deleteMessage: async (chatJid, msgId) => {
      calls.push({ method: 'deleteMessage', args: [chatJid, msgId] });
    },
    sendMessage: async (chatJid, text) => {
      calls.push({ method: 'sendMessage', args: [chatJid, text] });
    },
    sendPhoto: async (chatJid, path, caption) => {
      calls.push({ method: 'sendPhoto', args: [chatJid, path, caption] });
      return 3;
    },
    editPhoto: async (chatJid, msgId, path, caption) => {
      calls.push({ method: 'editPhoto', args: [chatJid, msgId, path, caption] });
      return true;
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    chatJid: 'tg:123',
    groupFolder: 'test-group',
    thinkingEnabled: true,
    verboseEnabled: false,
    ...overrides,
  };
}

// ─── isPipelineEvent ────────────────────────────────────────────────────────

describe('isPipelineEvent', () => {
  test('returns true for thinking event', () => {
    expect(isPipelineEvent({ type: 'thinking', content: 'abc' })).toBe(true);
  });

  test('returns true for response_delta event', () => {
    expect(isPipelineEvent({ type: 'response_delta', content: 'x' })).toBe(true);
  });

  test('returns true for tool_start event', () => {
    expect(isPipelineEvent({ type: 'tool_start', tool_name: 'Bash' })).toBe(true);
  });

  test('returns true for tool_progress event', () => {
    expect(isPipelineEvent({ type: 'tool_progress' })).toBe(true);
  });

  test('returns true for adapter_stderr event', () => {
    expect(isPipelineEvent({ type: 'adapter_stderr', message: 'err' })).toBe(true);
  });

  test('returns false for null', () => {
    expect(isPipelineEvent(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isPipelineEvent(undefined)).toBe(false);
  });

  test('returns false for string', () => {
    expect(isPipelineEvent('thinking')).toBe(false);
  });

  test('returns false for number', () => {
    expect(isPipelineEvent(42)).toBe(false);
  });

  test('returns false for object without type', () => {
    expect(isPipelineEvent({ content: 'abc' })).toBe(false);
  });

  test('returns false for unknown type', () => {
    expect(isPipelineEvent({ type: 'unknown_event' })).toBe(false);
  });

  test('returns false for non-string type', () => {
    expect(isPipelineEvent({ type: 123 })).toBe(false);
  });

  test('returns false for empty object', () => {
    expect(isPipelineEvent({})).toBe(false);
  });
});

// ─── humanizeToolName ───────────────────────────────────────────────────────

describe('humanizeToolName', () => {
  test('returns display name for known tool (Bash)', () => {
    expect(humanizeToolName('Bash')).toBe('running command');
  });

  test('returns display name for known tool (browse_navigate)', () => {
    expect(humanizeToolName('browse_navigate')).toBe('browsing');
  });

  test('returns display name for known tool (firecrawl_scrape)', () => {
    expect(humanizeToolName('firecrawl_scrape')).toBe('scraping page');
  });

  test('strips mcp__nanoclaw__ prefix before lookup', () => {
    expect(humanizeToolName('mcp__nanoclaw__browse_navigate')).toBe('browsing');
  });

  test('replaces underscores for unknown tools', () => {
    expect(humanizeToolName('custom_tool_name')).toBe('custom tool name');
  });

  test('strips prefix AND replaces underscores for unknown prefixed tools', () => {
    expect(humanizeToolName('mcp__nanoclaw__some_new_thing')).toBe('some new thing');
  });

  test('handles empty string', () => {
    expect(humanizeToolName('')).toBe('');
  });
});

// ─── TOOL_DISPLAY_NAMES ────────────────────────────────────────────────────

describe('TOOL_DISPLAY_NAMES', () => {
  test('contains all Claude SDK tools', () => {
    const sdkTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    for (const name of sdkTools) {
      expect(TOOL_DISPLAY_NAMES).toHaveProperty(name);
    }
  });

  test('contains all browse tools', () => {
    const browseTools = [
      'browse_navigate', 'browse_snapshot', 'browse_click', 'browse_click_xy',
      'browse_fill', 'browse_type_at_xy', 'browse_perform', 'browse_screenshot',
      'browse_wait_for_user', 'browse_go_back', 'browse_close', 'browse_extract_file',
      'browse_upload_file', 'browse_evaluate',
    ];
    for (const name of browseTools) {
      expect(TOOL_DISPLAY_NAMES).toHaveProperty(name);
    }
  });

  test('all values are non-empty strings', () => {
    for (const [key, value] of Object.entries(TOOL_DISPLAY_NAMES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ─── StreamingMessagePipeline ───────────────────────────────────────────────

describe('StreamingMessagePipeline', () => {
  let telegram: ReturnType<typeof makeMockTelegram>;
  let config: PipelineConfig;
  let pipeline: StreamingMessagePipeline;

  beforeEach(() => {
    telegram = makeMockTelegram();
    config = makeConfig();
    pipeline = new StreamingMessagePipeline(config, telegram);
  });

  // -- start() --------------------------------------------------------------

  describe('start()', () => {
    test('sends thinking message when thinkingEnabled', async () => {
      await pipeline.start();
      const statusCalls = telegram.calls.filter(c => c.method === 'sendStatusMessage');
      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0].args).toEqual(['tg:123', 'thinking']);
    });

    test('does not send message when thinkingEnabled is false', async () => {
      pipeline = new StreamingMessagePipeline(makeConfig({ thinkingEnabled: false }), telegram);
      await pipeline.start();
      expect(telegram.calls.length).toBe(0);
    });

    test('stores status message ID for subsequent edits', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // Wait past the rate limit (2500ms) so the edit goes through
      await Bun.sleep(2600);

      await pipeline.handleEvent({ type: 'thinking', content: 'Analyzing...' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(1);
      expect(editCalls[0].args[1]).toBe(1); // stored messageId from sendStatusMessage return
    });
  });

  // -- handleEvent() --------------------------------------------------------

  describe('handleEvent()', () => {
    test('thinking event edits status message with content', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // Wait past the rate limit (2500ms) so the edit goes through
      await Bun.sleep(2600);

      await pipeline.handleEvent({ type: 'thinking', content: 'Analyzing the request...' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(1);
      expect(editCalls[0].args[2]).toBe('Analyzing the request...');
    });

    test('thinking event sets hadThinkingContent (status kept on finish)', async () => {
      await pipeline.start();
      // Wait past rate limit so the thinking event is actually processed
      await Bun.sleep(2600);
      await pipeline.handleEvent({ type: 'thinking', content: 'Deep thought' });
      telegram.calls.length = 0;

      await pipeline.finish();
      // Status message should NOT be deleted because hadThinkingContent is true
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 1, // statusMessageId
      );
      expect(deleteCalls.length).toBe(0);
    });

    test('tool_start updates status with display name', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // Wait past the rate limit so the edit goes through
      await Bun.sleep(2600);

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'Bash' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(1);
      expect(editCalls[0].args[2]).toContain('running command');
    });

    test('hidden tool send_message does NOT update status', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'send_message' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(0);
    });

    test('hidden tool send_file does NOT update status', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'send_file' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(0);
    });

    test('hidden tool send_voice does NOT update status', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'send_voice' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(0);
    });

    test('strips mcp__nanoclaw__ prefix for hidden tool check', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'mcp__nanoclaw__send_message' });
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(0);
    });

    test('response_delta sends new streaming message on first call', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'response_delta', content: 'Hello' });
      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessageWithId');
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].args[1]).toBe('Hello');
    });

    test('adapter_stderr does not send telegram messages', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'adapter_stderr', message: 'some warning' });
      // No telegram messaging calls expected (only logging)
      const messagingCalls = telegram.calls.filter(
        c => c.method !== 'editStatusMessage', // exclude status edits from start()
      );
      expect(messagingCalls.length).toBe(0);
    });

    test('rate-limits status edits within interval', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // Wait past the rate limit, then send first event
      await Bun.sleep(2600);
      await pipeline.handleEvent({ type: 'thinking', content: 'First thought' });
      // Immediate second event should be suppressed (within 2.5s rate limit)
      await pipeline.handleEvent({ type: 'thinking', content: 'Second thought' });

      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBe(1);
    });

    test('rate-limits streaming message edits within interval', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // First delta creates the streaming message
      await pipeline.handleEvent({ type: 'response_delta', content: 'Hello' });
      // Immediate second delta should be suppressed
      await pipeline.handleEvent({ type: 'response_delta', content: 'Hello world' });

      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessageWithId');
      const editCalls = telegram.calls.filter(c => c.method === 'editMessageText');
      expect(sendCalls.length).toBe(1);
      expect(editCalls.length).toBe(0);
    });

    test('no status message means thinking events are ignored', async () => {
      pipeline = new StreamingMessagePipeline(
        makeConfig({ thinkingEnabled: false }),
        telegram,
      );
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'thinking', content: 'Ignored' });
      expect(telegram.calls.length).toBe(0);
    });

    test('verbose mode sends tool_start as separate message', async () => {
      pipeline = new StreamingMessagePipeline(
        makeConfig({ verboseEnabled: true }),
        telegram,
      );
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'Bash', preview: 'ls -la' });
      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessage');
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].args[1]).toContain('Bash');
    });

    test('verbose mode sends tool_progress as separate message', async () => {
      pipeline = new StreamingMessagePipeline(
        makeConfig({ verboseEnabled: true }),
        telegram,
      );
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({
        type: 'tool_progress',
        tool_name: 'Bash',
        elapsed_seconds: 5,
      });
      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessage');
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].args[1]).toContain('5s');
    });

    test('non-verbose mode does not send extra messages for tool events', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvent({ type: 'tool_start', tool_name: 'Bash' });
      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessage');
      expect(sendCalls.length).toBe(0);
    });
  });

  // -- handleEvents() -------------------------------------------------------

  describe('handleEvents()', () => {
    test('processes array of events sequentially', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      // Wait past rate limit so edits go through
      await Bun.sleep(2600);

      await pipeline.handleEvents([
        { type: 'thinking', content: 'First' },
        { type: 'tool_start', tool_name: 'Bash' },
      ]);

      // The first thinking event should trigger an edit (tool_start suppressed by rate limit)
      const editCalls = telegram.calls.filter(c => c.method === 'editStatusMessage');
      expect(editCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('handles empty array', async () => {
      await pipeline.start();
      telegram.calls.length = 0;

      await pipeline.handleEvents([]);
      expect(telegram.calls.length).toBe(0);
    });
  });

  // -- handleCuaStatus() ----------------------------------------------------

  describe('handleCuaStatus()', () => {
    test('sends new message on first call', async () => {
      await pipeline.handleCuaStatus('Navigating to page...');
      const sendCalls = telegram.calls.filter(c => c.method === 'sendMessageWithId');
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].args[1]).toBe('Navigating to page...');
    });

    test('edits existing message on subsequent call', async () => {
      await pipeline.handleCuaStatus('Step 1');
      telegram.calls.length = 0;

      await pipeline.handleCuaStatus('Step 2');
      const editCalls = telegram.calls.filter(c => c.method === 'editMessageText');
      expect(editCalls.length).toBe(1);
      expect(editCalls[0].args[2]).toBe('Step 2');
    });

    test('deduplicates identical text', async () => {
      await pipeline.handleCuaStatus('Same text');
      telegram.calls.length = 0;

      await pipeline.handleCuaStatus('Same text');
      expect(telegram.calls.length).toBe(0);
    });

    test('sends new message when edit fails', async () => {
      const tg = makeMockTelegram({
        editMessageText: async () => false,
      });
      const p = new StreamingMessagePipeline(config, tg);

      await p.handleCuaStatus('Step 1');
      tg.calls.length = 0;

      await p.handleCuaStatus('Step 2');
      // Edit failed, should fall through to sendMessageWithId
      const sendCalls = tg.calls.filter(c => c.method === 'sendMessageWithId');
      expect(sendCalls.length).toBe(1);
    });
  });

  // -- handleCuaScreenshot() ------------------------------------------------

  describe('handleCuaScreenshot()', () => {
    test('sends photo on first call', async () => {
      await pipeline.handleCuaScreenshot('/tmp/screenshot.png');
      const photoCalls = telegram.calls.filter(c => c.method === 'sendPhoto');
      expect(photoCalls.length).toBe(1);
      expect(photoCalls[0].args[1]).toBe('/tmp/screenshot.png');
    });

    test('edits photo on subsequent call', async () => {
      await pipeline.handleCuaScreenshot('/tmp/first.png');
      telegram.calls.length = 0;

      await pipeline.handleCuaScreenshot('/tmp/second.png');
      const editCalls = telegram.calls.filter(c => c.method === 'editPhoto');
      expect(editCalls.length).toBe(1);
      expect(editCalls[0].args[2]).toBe('/tmp/second.png');
    });

    test('sends new photo when edit fails', async () => {
      const tg = makeMockTelegram({
        editPhoto: async () => false,
      });
      const p = new StreamingMessagePipeline(config, tg);

      await p.handleCuaScreenshot('/tmp/first.png');
      tg.calls.length = 0;

      await p.handleCuaScreenshot('/tmp/second.png');
      // Edit failed, should fall through to sendPhoto
      const photoCalls = tg.calls.filter(c => c.method === 'sendPhoto');
      expect(photoCalls.length).toBe(1);
    });

    test('handles sendPhoto error gracefully', async () => {
      const tg = makeMockTelegram({
        sendPhoto: async () => {
          throw new Error('Network error');
        },
      });
      const p = new StreamingMessagePipeline(config, tg);

      // Should not throw
      await p.handleCuaScreenshot('/tmp/screenshot.png');
    });
  });

  // -- finish() -------------------------------------------------------------

  describe('finish()', () => {
    test('deletes streaming message', async () => {
      await pipeline.start();
      await pipeline.handleEvent({ type: 'response_delta', content: 'Hello' });
      telegram.calls.length = 0;

      await pipeline.finish();
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 2, // streamingMessageId
      );
      expect(deleteCalls.length).toBe(1);
    });

    test('deletes status message when no thinking content', async () => {
      await pipeline.start();
      // Don't send any thinking events
      telegram.calls.length = 0;

      await pipeline.finish();
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 1, // statusMessageId
      );
      expect(deleteCalls.length).toBe(1);
    });

    test('keeps status message when thinking content exists and thinking enabled', async () => {
      await pipeline.start();
      // Wait past rate limit so the thinking event is processed
      await Bun.sleep(2600);
      await pipeline.handleEvent({ type: 'thinking', content: 'Deep reasoning' });
      telegram.calls.length = 0;

      await pipeline.finish();
      // Status message should NOT be deleted
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 1,
      );
      expect(deleteCalls.length).toBe(0);
    });

    test('deletes CUA text message', async () => {
      await pipeline.handleCuaStatus('CUA text');
      telegram.calls.length = 0;

      await pipeline.finish();
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 2, // cuaTextMessageId
      );
      expect(deleteCalls.length).toBe(1);
    });

    test('deletes CUA screenshot message', async () => {
      await pipeline.handleCuaScreenshot('/tmp/screenshot.png');
      telegram.calls.length = 0;

      await pipeline.finish();
      const deleteCalls = telegram.calls.filter(
        c => c.method === 'deleteMessage' && c.args[1] === 3, // cuaScreenshotMessageId
      );
      expect(deleteCalls.length).toBe(1);
    });

    test('handles finish with no messages to clean up', async () => {
      // Pipeline that never called start() or handled events
      await pipeline.finish();
      // Should complete without error
      expect(telegram.calls.length).toBe(0);
    });
  });

  // -- Voice deduplication --------------------------------------------------

  describe('voice deduplication', () => {
    test('consumeVoiceSent returns false when not marked', () => {
      expect(pipeline.consumeVoiceSent()).toBe(false);
    });

    test('markVoiceSent then consumeVoiceSent returns true', () => {
      pipeline.markVoiceSent();
      expect(pipeline.consumeVoiceSent()).toBe(true);
    });

    test('consumeVoiceSent resets flag after consuming', () => {
      pipeline.markVoiceSent();
      pipeline.consumeVoiceSent(); // first call returns true
      expect(pipeline.consumeVoiceSent()).toBe(false); // second returns false
    });
  });
});
