/**
 * Verify ToolRegistry: all tools registered, dispatch, and schema validity.
 */

import { describe, it, expect } from 'bun:test';
import { Effect, Layer } from 'effect';
import { z } from 'zod';

import { ALL_TOOLS } from '../tools/index.js';
import {
  ToolRegistry,
  ToolRegistryLive,
} from '../services/ToolRegistry.js';
import { HostBridge, HostBridgeTest } from '../services/HostBridge.js';
import { ToolError } from '../errors/index.js';

// ─── Expected tool names (38 total) ────────────────────────────────────────

const EXPECTED_TOOL_NAMES = [
  // Communication (3)
  'send_message',
  'send_file',
  'send_voice',
  // Audio (4)
  'download_audio',
  'download_video',
  'convert_audio',
  'transcribe_audio',
  // Tasks (5)
  'schedule_task',
  'list_tasks',
  'pause_task',
  'resume_task',
  'cancel_task',
  // Groups (1)
  'register_group',
  // Skills (3)
  'store_skill',
  'list_skills',
  'delete_skill',
  // Browse (15)
  'browse_navigate',
  'browse_snapshot',
  'browse_click',
  'browse_click_xy',
  'browse_type_at_xy',
  'browse_perform',
  'browse_fill',
  'browse_scroll',
  'browse_screenshot',
  'browse_wait_for_user',
  'browse_go_back',
  'browse_evaluate',
  'browse_close',
  'browse_extract_file',
  'browse_upload_file',
  // Firecrawl (3)
  'firecrawl_scrape',
  'firecrawl_crawl',
  'firecrawl_map',
  // Memory (2)
  'memory_save',
  'memory_search',
  // Filesystem (2)
  'read_file',
  'write_file',
];

describe('ToolRegistry', () => {
  it('registers all 38 tools', () => {
    expect(ALL_TOOLS.length).toBe(38);
  });

  it('contains all expected tool names', () => {
    const toolNames = ALL_TOOLS.map((t) => t.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(toolNames).toContain(expected);
    }
  });

  it('has no duplicate tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all tools have valid Zod schemas', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.schema).toBeDefined();
      expect(tool.schema instanceof z.ZodObject).toBe(true);
      // Ensure the schema can parse at least an empty object (may fail validation,
      // but parsing itself should not throw)
      expect(() => tool.schema.safeParse({})).not.toThrow();
    }
  });

  it('all tools have non-empty descriptions', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('all tools have handler functions', () => {
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('ToolRegistryLive resolves and lists all tools', async () => {
    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      expect(registry.tools.length).toBe(38);
      return registry.tools.map((t) => t.name);
    });

    const names = await Effect.runPromise(
      program.pipe(Effect.provide(ToolRegistryLive)),
    );
    expect(names.length).toBe(38);
  });

  it('unknown tool dispatch fails with ToolError', async () => {
    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      const result = yield* registry
        .execute(
          'nonexistent_tool',
          {},
          { chatJid: 'test', groupFolder: 'test', isMain: false },
        )
        .pipe(Effect.either);

      if (result._tag === 'Left') {
        const error = result.left;
        expect(error).toBeInstanceOf(ToolError);
        expect(error.toolName).toBe('nonexistent_tool');
        expect(error.message).toContain('Unknown tool');
        return 'failed as expected';
      }
      return 'should have failed';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.merge(ToolRegistryLive, HostBridgeTest))),
    );
    expect(result).toBe('failed as expected');
  });

  describe('Tool categorization', () => {
    it('communication tools exist', () => {
      const names = ALL_TOOLS.map((t) => t.name);
      expect(names).toContain('send_message');
      expect(names).toContain('send_file');
      expect(names).toContain('send_voice');
    });

    it('browse tools exist (15)', () => {
      const browseTools = ALL_TOOLS.filter((t) =>
        t.name.startsWith('browse_'),
      );
      expect(browseTools.length).toBe(15);
    });

    it('firecrawl tools exist (3)', () => {
      const firecrawlTools = ALL_TOOLS.filter((t) =>
        t.name.startsWith('firecrawl_'),
      );
      expect(firecrawlTools.length).toBe(3);
    });

    it('memory tools exist (2)', () => {
      const memoryTools = ALL_TOOLS.filter((t) =>
        t.name.startsWith('memory_'),
      );
      expect(memoryTools.length).toBe(2);
    });
  });
});
