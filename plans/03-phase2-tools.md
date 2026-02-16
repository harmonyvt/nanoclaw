# Phase 2: Container Agent — Tools Decomposition

## Goal

Extract tools from the monolithic `container/agent-runner/src/tool-registry.ts` (2,243 lines) into 10 category modules in `container/agent-runner-v2/src/tools/`. Each handler wraps existing logic in `Effect.tryPromise()` as a mechanical port. Implement `ToolRegistry`, `HostBridge`, and `Cancellation` services.

## Source File to Decompose

`container/agent-runner/src/tool-registry.ts` — contains all **37 tool definitions** with Zod schemas and Promise-based handlers, plus shared utilities (`runCommand`, `requestHost`, `dispatchTaskAction`, `summarizeAccessibilityTree`, `writeIpcFile`, `writeBrowseRequest`).

## Shared Utilities

Before extracting tool modules, port these shared helpers used across multiple tool categories:

### `tools/utils.ts` — Shared Utilities

- **`runCommand(cmd: string[], timeoutMs = 120000)`** — Spawns a subprocess via `Bun.spawn` with stdout/stderr piping and timeout. Returns `{ stdout, stderr, exitCode }`. Used by `download_audio` and `convert_audio`. Port as an Effect wrapper around `Bun.spawn`.
- **`writeIpcFile(dir, data)`** — Atomic JSON file write (temp + rename) to IPC directory. Returns filename.

### `tools/browse-utils.ts` — Accessibility Tree Summarizer

- **`summarizeAccessibilityTree(rawSnapshot: string)`** — Complex 130-line function that post-processes `browse_snapshot` results. Parses raw accessibility tree text, categorizes elements by role (interactive vs content), and produces a concise summary. Key constants:
  - `SNAPSHOT_MAX_INTERACTIVE = 30` — max interactive elements to show
  - `SNAPSHOT_MAX_CONTENT = 15` — max content elements to show
  - `SNAPSHOT_MAX_RAW_CHARS = 10000` — raw snapshot size limit before summarization kicks in

## Dual-Dispatch Pattern (HostBridge)

Every tool handler in v1 follows a dual-dispatch pattern: try RPC bridge first via `requestHost()`, fall back to file-based IPC. The v2 `HostBridge` service must encapsulate this transparently so tool handlers simply call `bridge.request(method, params)` without knowing the transport:

```typescript
// v2: HostBridge handles dual-dispatch internally
const bridge = yield* HostBridge;
// In persistent mode: sends over Unix socket RPC
// In one-shot mode: writes to /workspace/ipc/ files
const result = yield* bridge.request('tasks.handle', data);
```

The `HostBridge` Layer variant (persistent vs one-shot) is selected at startup and injected via Layer composition. Tool handlers are transport-agnostic.

## Target Tool Modules

### 1. `tools/communication.ts` — 3 tools
- `send_message` — Write JSON to IPC messages dir
- `send_file` — Write file-send JSON to IPC messages dir (path validation: must be under `/workspace/group/` or `/workspace/global/`)
- `send_voice` — TTS synthesis + write voice-send JSON to IPC messages dir

### 2. `tools/audio.ts` — 3 tools
- `download_audio` — yt-dlp download from URL. Uses `runCommand()`. Filename sanitization (regex replace non-alphanumeric). Fallback file finding if expected output path differs from actual.
- `convert_audio` — ffmpeg format/sample-rate/mono/trim conversion. Uses `runCommand()` with 60s timeout.
- `transcribe_audio` — Replicate GPT-4o-transcribe. Polls prediction status (120s timeout, 1s polling interval).

### 3. `tools/tasks.ts` — 5 tools
- `schedule_task` — Create cron/interval/once task via IPC
- `list_tasks` — Read `current_tasks.json`
- `pause_task` — Write pause request to IPC
- `resume_task` — Write resume request to IPC
- `cancel_task` — Write cancel request to IPC

All task tools use a **unified `dispatchTaskAction()` helper** that tries RPC `tasks.handle` first, then falls back to file IPC via `writeIpcFile(TASKS_DIR, data)`.

### 4. `tools/groups.ts` — 1 tool
- `register_group` — Write group registration to IPC (main only)

### 5. `tools/skills.ts` — 3 tools
- `store_skill` — Save skill JSON to group skills dir + notify host. Validates name with regex `/^[a-z][a-z0-9_]{1,30}$/`. Checks 18 reserved names (`tasks`, `runtask`, `new`, `clear`, `status`, `update`, `rebuild`, `takeover`, `dashboard`, `follow`, `verbose`, `stop`, `help`, `skills`, `start`, `settings`, `cancel`, `menu`, `debug`). Preserves `created_at` on updates. Can use `memory_search` to enrich instructions.
- `list_skills` — Read skills dir
- `delete_skill` — Delete skill file + notify host

### 6. `tools/browse.ts` — 15 tools
- `browse_navigate` — Go to URL
- `browse_snapshot` — Get accessibility tree; result passed through `summarizeAccessibilityTree()`
- `browse_click` — Click by description text
- `browse_click_xy` — Click at exact pixel coordinates (fallback)
- `browse_type_at_xy` — Click at coordinates then type (supports `clear_first: true` for Ctrl+A)
- `browse_perform` — Execute sequence of desktop actions (9 action types: `click`, `double_click`, `right_click`, `key`, `type`, `scroll`, `drag`, `hover`, `wait`). Complex per-action Zod schemas. **120s timeout** (2x normal).
- `browse_fill` — Fill form field by description
- `browse_scroll` — Scroll page by direction + clicks (standalone tool, not inside `browse_perform`). Default 3 clicks.
- `browse_screenshot` — Capture page. Complex result handling: summary extraction, multiple path strategies (group media dir), base64 for vision. Also sent as Telegram photo.
- `browse_wait_for_user` — Handoff to user via takeover URL. **300s timeout**.
- `browse_go_back` — Browser back button
- `browse_evaluate` — JavaScript eval (compat stub, returns error in CUA mode)
- `browse_close` — Close browser page
- `browse_extract_file` — Extract file from CUA sandbox to agent. **120s timeout**.
- `browse_upload_file` — Upload file from agent into CUA sandbox. **120s timeout**.

### 7. `tools/firecrawl.ts` — 3 tools
- `firecrawl_scrape` — Single page to markdown (50KB max)
- `firecrawl_crawl` — Multi-page crawl (100KB max)
- `firecrawl_map` — URL discovery

### 8. `tools/memory.ts` — 2 tools
- `memory_save` — Store note/fact to Supermemory. Uses `containerTags: ['nanoclaw_{groupFolder}']` for per-group isolation.
- `memory_search` — Search past memories. Uses same `containerTag` pattern.

### 9. `tools/filesystem.ts` — 2 tools
- `read_file` — Read file from group or global workspace. Path validation: must resolve under `/workspace/group/` or `/workspace/global/`. **100,000 character truncation limit** with `[Truncated at 100000 characters]` suffix.
- `write_file` — Write file to group workspace. Path validation: must resolve under `/workspace/group/` only. Atomic write (temp + rename). Creates parent directories automatically.

**Total: 37 tools across 9 modules**

## Handler Pattern

Each tool handler changes from:

```typescript
// v1: Promise-based, flat return struct
handler: async (args, ctx): Promise<ToolResult> => {
  const { message } = args as { message: string };
  await writeFile(path, JSON.stringify(payload));
  return { content: 'Sent.' };
  // ToolResult = { content: string, isError?: boolean, imageBase64?: string, imageMimeType?: string }
}
```

To:

```typescript
// v2: Effect-based, same flat return struct
handler: (args, ctx) => Effect.gen(function* () {
  const { message } = args as { message: string };
  const bridge = yield* HostBridge;
  yield* Effect.tryPromise({
    try: () => writeFile(path, JSON.stringify(payload)),
    catch: (err) => new ToolError({ tool: 'send_message', message: String(err) }),
  });
  return { content: 'Sent.' };
  // Returns same ToolResult flat struct — the MCP bridge layer converts to content array format
})
```

**Important**: The `{ content: [{ type: 'text', text: '...' }] }` array format only exists in the MCP bridge layer (`ipc-mcp.ts`) that wraps tool results for the Claude Agent SDK. Tool handlers themselves always return the flat `ToolResult` struct: `{ content: string, isError?: boolean, imageBase64?: string, imageMimeType?: string }`.

## Browse Tools — IPC Pattern

Browse tools use a request/response IPC pattern. In v2, the `HostBridge` service encapsulates this:

```typescript
// v1: manual file polling with dual-dispatch
const viaRpc = await requestHost<HostBrowseResult>('browse.handle', { action, params, timeoutMs });
if (viaRpc) return viaRpc;
// ...fall back to file-based IPC: write req-{id}.json, poll for res-{id}.json

// v2: via HostBridge service (dual-dispatch is internal)
const bridge = yield* HostBridge;
const response = yield* bridge.browseRequest(request);
```

In persistent mode, `HostBridge` sends browse requests over the Unix socket RPC. In one-shot mode, it falls back to file-based IPC (write `req-{id}.json`, poll for `res-{id}.json`).

## ToolRegistry Service Implementation

```typescript
// Collects all tool modules, dispatches by name
const ToolRegistryLive = Layer.effect(
  ToolRegistry,
  Effect.gen(function* () {
    const toolMap = new Map(ALL_TOOLS.map(t => [t.name, t]));
    return {
      listTools: Effect.succeed(ALL_TOOLS),
      dispatch: (name, args, ctx) => {
        const tool = toolMap.get(name);
        if (!tool) return Effect.fail(new ToolError({ tool: name, message: 'Unknown tool' }));
        return tool.handler(args, ctx);
      },
      getToolSchemas: Effect.succeed(
        ALL_TOOLS.map(t => ({ name: t.name, description: t.description, schema: t.schema }))
      ),
    };
  }),
);
```

## HostBridge Service Implementation

Two Layer variants:

### HostBridgePersistent
- Connects to Unix domain socket provided via env var
- Sends/receives newline-delimited JSON (custom format: `{ type, id?, method?, params?, result?, error? }`)
- `request(method, params)` tries RPC first, falls back if socket not available
- `browseRequest` / `sendMessage` / `emitEvent` map to RPC calls
- Connection lifecycle managed by Layer scope

### HostBridgeOneShot
- Falls back to file-based IPC (write to `/workspace/ipc/`)
- `browseRequest` polls for response files (legacy pattern)
- `emitEvent` writes status files

## Cancellation Service

Already implemented in Phase 1 (`CancellationLive`). Uses `Deferred<void, CancellationError>` as signal + `Fiber.interrupt` for clean cancellation.

## Checklist

- [ ] Implement `tools/utils.ts` — `runCommand()` wrapper, `writeIpcFile()`, shared helpers
- [ ] Implement `tools/browse-utils.ts` — `summarizeAccessibilityTree()` (130 lines)
- [ ] Extract `tools/communication.ts` (3 tools)
- [ ] Extract `tools/audio.ts` (3 tools) — uses `runCommand()`
- [ ] Extract `tools/tasks.ts` (5 tools) — uses `dispatchTaskAction()` helper
- [ ] Extract `tools/groups.ts` (1 tool)
- [ ] Extract `tools/skills.ts` (3 tools) — name validation, reserved names, `created_at` preservation
- [ ] Extract `tools/browse.ts` (15 tools) — includes `browse_scroll`, custom timeouts
- [ ] Extract `tools/firecrawl.ts` (3 tools)
- [ ] Extract `tools/memory.ts` (2 tools) — `containerTag: 'nanoclaw_{groupFolder}'`
- [ ] Extract `tools/filesystem.ts` (2 tools) — path validation, 100K char truncation
- [ ] Update `tools/index.ts` to import and spread all 10 modules
- [ ] Implement `ToolRegistryLive` Layer
- [ ] Implement `HostBridgePersistent` Layer (dual-dispatch: RPC first, file IPC fallback)
- [ ] Implement `HostBridgeOneShot` Layer (file IPC only)
- [ ] Verify all 37 tools compile with Effect-based handlers
