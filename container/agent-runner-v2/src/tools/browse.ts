/**
 * Browser automation tools: 15 browse_* tools using IPC request/response pattern.
 */

import { z } from 'zod';
import fs from 'fs';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import type { HostBridge } from '../services/HostBridge.js';
import { ToolError } from '../errors/index.js';
import { summarizeAccessibilityTree } from './browse-utils.js';
import { requestHost, writeIpcFile, BROWSE_DIR, type HostBrowseResult } from './utils.js';

/**
 * Send a browse request to the host via RPC, falling back to file-based IPC.
 */
function writeBrowseRequest(
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 60000,
): Effect.Effect<HostBrowseResult, ToolError, HostBridge> {
  return Effect.gen(function* () {
    const viaRpc = yield* requestHost('browse.handle', {
      action,
      params,
      timeoutMs,
    });
    if (viaRpc) return viaRpc as HostBrowseResult;

    // Fall back to file-based IPC
    return yield* Effect.tryPromise({
      try: async () => {
        fs.mkdirSync(BROWSE_DIR, { recursive: true });

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const reqFile = `${BROWSE_DIR}/req-${id}.json`;
        const resFile = `${BROWSE_DIR}/res-${id}.json`;

        // Atomic write request
        const tempReq = `${reqFile}.tmp`;
        fs.writeFileSync(tempReq, JSON.stringify({ id, action, params }));
        fs.renameSync(tempReq, reqFile);

        // Poll for response
        const pollInterval = 500;
        const deadline = Date.now() + timeoutMs;
        const cancelFile = '/workspace/ipc/cancel';

        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          // Check for user interrupt (host writes cancel file)
          try {
            if (fs.existsSync(cancelFile)) {
              try { fs.unlinkSync(reqFile); } catch { /* ignore */ }
              try { fs.unlinkSync(resFile); } catch { /* ignore */ }
              return {
                status: 'error',
                error: 'Browse request cancelled by user interrupt',
              } as HostBrowseResult;
            }
          } catch { /* ignore */ }

          if (fs.existsSync(resFile)) {
            const data = JSON.parse(fs.readFileSync(resFile, 'utf-8')) as HostBrowseResult;
            try { fs.unlinkSync(reqFile); } catch { /* ignore */ }
            try { fs.unlinkSync(resFile); } catch { /* ignore */ }
            return data;
          }
        }

        // Timeout - clean up request file
        try { fs.unlinkSync(reqFile); } catch { /* ignore */ }
        return {
          status: 'error',
          error: `Browse request timed out after ${timeoutMs / 1000}s`,
        } as HostBrowseResult;
      },
      catch: (err) =>
        new ToolError({
          toolName: `browse_${action}`,
          message: `Browse IPC failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }),
    });
  });
}

export const browseTools: NanoTool[] = [
  {
    name: 'browse_navigate',
    description:
      'Navigate the sandboxed browser/desktop to a URL. Returns a short navigation result.',
    schema: z.object({
      url: z.string().describe('The URL to navigate to'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('navigate', { url: args.url as string });
        if (res.status === 'error') {
          return { content: `Navigation failed: ${res.error}`, isError: true as const };
        }
        return { content: `Navigated to page: ${res.result}` };
      }),
  },

  {
    name: 'browse_snapshot',
    description:
      'Get a structured snapshot of the current page or desktop UI. Returns labeled interactive and content elements. Useful for understanding visible structure and finding elements to interact with.',
    schema: z.object({}),
    handler: () =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('snapshot', {});
        if (res.status === 'error') {
          return { content: `Snapshot failed: ${res.error}`, isError: true as const };
        }
        return { content: summarizeAccessibilityTree(String(res.result)) };
      }),
  },

  {
    name: 'browse_click',
    description:
      'Click an element by human-readable description text (selector-like hints are best-effort).',
    schema: z.object({
      selector: z
        .string()
        .describe(
          'Description text to click (e.g., "text=Sign In", "Search"); CSS-like selectors are treated as hints',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('click', { selector: args.selector as string });
        if (res.status === 'error') {
          return { content: `Click failed: ${res.error}`, isError: true as const };
        }
        return { content: `Click result: ${res.result}` };
      }),
  },

  {
    name: 'browse_click_xy',
    description:
      'Click at exact pixel coordinates on the screen. Use this when browse_click fails to find an element, or when you know the coordinates from a screenshot analysis or visual inspection.',
    schema: z.object({
      x: z.number().int().describe('X coordinate in pixels from left edge of screen'),
      y: z.number().int().describe('Y coordinate in pixels from top edge of screen'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('click_xy', {
          x: args.x as number,
          y: args.y as number,
        });
        if (res.status === 'error') {
          return { content: `Click at (${args.x}, ${args.y}) failed: ${res.error}`, isError: true as const };
        }
        return { content: `Click result: ${res.result}` };
      }),
  },

  {
    name: 'browse_type_at_xy',
    description:
      'Click at exact pixel coordinates then type text. Use when browse_fill fails to find the input field. Clicks the coordinates first, then types the value.',
    schema: z.object({
      x: z.number().int().describe('X coordinate of the input field in pixels'),
      y: z.number().int().describe('Y coordinate of the input field in pixels'),
      value: z.string().describe('The text to type into the field'),
      clear_first: z
        .boolean()
        .optional()
        .describe(
          'If true, selects all existing content (Ctrl+A) after clicking before typing, replacing instead of appending. Useful for overwriting cell values in spreadsheets.',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('type_at_xy', {
          x: args.x as number,
          y: args.y as number,
          value: args.value as string,
          clear_first: args.clear_first as boolean | undefined,
        });
        if (res.status === 'error') {
          return { content: `Type at (${args.x}, ${args.y}) failed: ${res.error}`, isError: true as const };
        }
        return { content: `Type result: ${res.result}` };
      }),
  },

  {
    name: 'browse_perform',
    description:
      'Execute one or more browser/desktop actions as a sequence. Supports click, double_click, right_click, key press, type text, scroll, drag, hover, and wait. Use this for keyboard shortcuts (ctrl+a, f2, enter, escape, tab, delete), double-clicking, and composing multi-step interactions like editing spreadsheet cells. Example: to edit a cell, use steps: [{action:"double_click",x:200,y:300},{action:"key",key:"ctrl+a"},{action:"type",text:"new value"},{action:"key",key:"enter"}]',
    schema: z.object({
      steps: z
        .array(
          z.object({
            action: z
              .enum([
                'click',
                'double_click',
                'right_click',
                'key',
                'type',
                'scroll',
                'drag',
                'hover',
                'wait',
              ])
              .describe('The action to perform'),
            x: z.number().optional().describe('X coordinate (for click/double_click/right_click/scroll/hover)'),
            y: z.number().optional().describe('Y coordinate (for click/double_click/right_click/scroll/hover)'),
            key: z.string().optional().describe('Key or shortcut to press (for key action, e.g. "enter", "escape", "tab", "f2", "ctrl+a", "ctrl+c", "ctrl+v", "shift+enter", "delete", "backspace")'),
            text: z.string().optional().describe('Text to type (for type action)'),
            direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (for scroll action)'),
            amount: z.number().optional().describe('Scroll clicks, default 3 (for scroll action)'),
            from_x: z.number().optional().describe('Drag start X (for drag action)'),
            from_y: z.number().optional().describe('Drag start Y (for drag action)'),
            to_x: z.number().optional().describe('Drag end X (for drag action)'),
            to_y: z.number().optional().describe('Drag end Y (for drag action)'),
            ms: z.number().optional().describe('Wait duration in ms, max 5000 (for wait action)'),
          }),
        )
        .min(1)
        .describe('Ordered list of actions to execute sequentially'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('perform', { steps: args.steps }, 120000);
        if (res.status === 'error') {
          return { content: `Perform failed: ${res.error}`, isError: true as const };
        }
        return { content: `Perform result: ${res.result}` };
      }),
  },

  {
    name: 'browse_fill',
    description:
      'Fill a form field with a value. Finds the target element and types the value.',
    schema: z.object({
      selector: z
        .string()
        .describe(
          'Description text of the input field (e.g., "Email", "Search"); CSS-like selectors are treated as hints',
        ),
      value: z.string().describe('The value to type into the field'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('fill', {
          selector: args.selector as string,
          value: args.value as string,
        });
        if (res.status === 'error') {
          return { content: `Fill failed: ${res.error}`, isError: true as const };
        }
        return { content: `Fill result: ${res.result}` };
      }),
  },

  {
    name: 'browse_scroll',
    description:
      'Scroll the current page. Specify direction and number of scroll clicks (each click is roughly one mouse wheel notch). Default is 3 clicks.',
    schema: z.object({
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe('Scroll direction'),
      clicks: z
        .number()
        .int()
        .optional()
        .describe(
          'Number of scroll wheel clicks (default 3). Use larger values like 10 to scroll further.',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('scroll', {
          direction: args.direction as string,
          clicks: (args.clicks as number | undefined) ?? 3,
        });
        if (res.status === 'error') {
          return { content: `Scroll failed: ${res.error}`, isError: true as const };
        }
        return { content: `Scroll complete: ${res.result}` };
      }),
  },

  {
    name: 'browse_screenshot',
    description:
      'Take a screenshot of the current browser page. Returns the saved image path plus labeled UI elements mapped to grid cells. If the text summary is insufficient or elements are missing, use the Read tool on the screenshot file path to visually inspect the image.',
    schema: z.object({}),
    handler: () =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('screenshot', {});
        if (res.status === 'error') {
          return { content: `Screenshot failed: ${res.error}`, isError: true as const };
        }

        const summary =
          res.analysis && typeof res.analysis.summary === 'string'
            ? res.analysis.summary
            : null;
        const payloadPath =
          res.screenshot && typeof res.screenshot.path === 'string'
            ? res.screenshot.path
            : '';
        const screenshotPath = typeof res.result === 'string' ? res.result : payloadPath;
        const hint = screenshotPath
          ? `\n\nTo visually inspect this screenshot, use the Read tool on: ${screenshotPath}`
          : '';
        const sourceHint =
          res.screenshot?.analysisSource === 'omniparser'
            ? '\n\nElement detection source: OmniParser.'
            : '';

        // Attach screenshot image bytes for vision-capable adapters
        let imageBase64: string | undefined;
        let imageMimeType: string | undefined;
        if (
          res.screenshot &&
          typeof res.screenshot.base64 === 'string' &&
          res.screenshot.base64.length > 0
        ) {
          imageBase64 = res.screenshot.base64;
          imageMimeType =
            typeof res.screenshot.mimeType === 'string'
              ? res.screenshot.mimeType
              : 'image/png';
        }
        if (screenshotPath) {
          try {
            if (!imageBase64) {
              const imgBytes = fs.readFileSync(screenshotPath);
              imageBase64 = imgBytes.toString('base64');
              imageMimeType = 'image/png';
            }
          } catch {
            // Ignore -- image will still be available via Read tool for Claude
          }
        }

        return {
          content: (summary || `Screenshot saved: ${res.result}`) + sourceHint + hint,
          imageBase64,
          imageMimeType,
        };
      }),
  },

  {
    name: 'browse_wait_for_user',
    description:
      'Ask the user to take over the sandbox directly (e.g., to log in), then wait for control to return. Sends a chat message with a takeover web URL (and direct noVNC fallback) plus your instructions.',
    schema: z.object({
      message: z
        .string()
        .describe(
          'Message to send to the user explaining what they need to do in takeover mode (e.g., "Please log in and click Return Control To Agent when done")',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest(
          'wait_for_user',
          { message: args.message as string },
          300000,
        );
        if (res.status === 'error') {
          return { content: `Wait for user failed: ${res.error}`, isError: true as const };
        }
        return { content: 'User has continued.' };
      }),
  },

  {
    name: 'browse_go_back',
    description:
      'Navigate back in browser history (like clicking the back button).',
    schema: z.object({}),
    handler: () =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('go_back', {});
        if (res.status === 'error') {
          return { content: `Go back failed: ${res.error}`, isError: true as const };
        }
        return { content: `Navigated back to: ${res.result}` };
      }),
  },

  {
    name: 'browse_evaluate',
    description:
      'Execute a JavaScript expression on the current page and return the result. Currently unsupported in CUA sandbox mode and returns an error.',
    schema: z.object({
      expression: z
        .string()
        .describe(
          'JavaScript expression to evaluate (e.g., "document.title", "window.location.href", "document.querySelectorAll(\'a\').length")',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('evaluate', {
          expression: args.expression as string,
        });
        if (res.status === 'error') {
          return { content: `Evaluate failed: ${res.error}`, isError: true as const };
        }
        return { content: String(res.result) };
      }),
  },

  {
    name: 'browse_close',
    description: 'Close the current browser page/tab.',
    schema: z.object({}),
    handler: () =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest('close', {});
        if (res.status === 'error') {
          return { content: `Close failed: ${res.error}`, isError: true as const };
        }
        return { content: 'Browser page closed.' };
      }),
  },

  {
    name: 'browse_extract_file',
    description:
      'Extract/download a file from the CUA sandbox desktop to the agent. Returns the local file path which can then be sent to the user via send_file. Useful for downloading files the browser saved, exporting documents, etc.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to the file inside the CUA sandbox (e.g., "/root/Downloads/report.pdf", "~/Documents/data.csv")',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest(
          'extract_file',
          { path: args.path as string },
          120000,
        );
        if (res.status === 'error') {
          return { content: `File extraction failed: ${res.error}`, isError: true as const };
        }
        return { content: `File extracted to: ${res.result}` };
      }),
  },

  {
    name: 'browse_upload_file',
    description:
      'Upload a file from the agent into the CUA sandbox desktop. Useful for making files received from Telegram available in the browser environment (e.g., uploading a document to a web form).',
    schema: z.object({
      source_path: z
        .string()
        .describe(
          'Path to the file inside the agent container (e.g., "/workspace/group/media/document.pdf")',
        ),
      destination_path: z
        .string()
        .optional()
        .describe(
          'Destination path inside the CUA sandbox (default: ~/Downloads/{filename})',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const res = yield* writeBrowseRequest(
          'upload_file',
          {
            source_path: args.source_path as string,
            destination_path: (args.destination_path as string) || null,
          },
          120000,
        );
        if (res.status === 'error') {
          return { content: `File upload failed: ${res.error}`, isError: true as const };
        }
        return { content: `File uploaded: ${res.result}` };
      }),
  },
];
