# Phase 2: Container Agent — Tools Decomposition

## Goal

Extract tools from the monolithic `container/agent-runner/src/tool-registry.ts` (2,243 lines) into 9 category modules in `container/agent-runner-v2/src/tools/`. Each handler wraps existing logic in `Effect.tryPromise()` as a mechanical port. Implement `ToolRegistry`, `HostBridge`, and `Cancellation` services.

## Source File to Decompose

`container/agent-runner/src/tool-registry.ts` — contains all 22 tool definitions with Zod schemas and Promise-based handlers.

## Target Tool Modules

### 1. `tools/communication.ts` — 3 tools
- `send_message` — Write JSON to IPC messages dir
- `send_file` — Write file-send JSON to IPC messages dir
- `send_voice` — TTS synthesis + write voice-send JSON to IPC messages dir

### 2. `tools/audio.ts` — 3 tools
- `download_audio` — yt-dlp download from URL
- `convert_audio` — ffmpeg format/sample-rate/mono/trim conversion
- `transcribe_audio` — Replicate GPT-4o-transcribe

### 3. `tools/tasks.ts` — 5 tools
- `schedule_task` — Create cron/interval/once task via IPC
- `list_tasks` — Read `current_tasks.json`
- `pause_task` — Write pause request to IPC
- `resume_task` — Write resume request to IPC
- `cancel_task` — Write cancel request to IPC

### 4. `tools/groups.ts` — 1 tool
- `register_group` — Write group registration to IPC (main only)

### 5. `tools/skills.ts` — 3 tools
- `store_skill` — Save skill JSON to group skills dir + notify host
- `list_skills` — Read skills dir
- `delete_skill` — Delete skill file + notify host

### 6. `tools/browse.ts` — 12 tools
- `browse_navigate`, `browse_snapshot`, `browse_click`, `browse_click_xy`
- `browse_perform`, `browse_fill`, `browse_type_at_xy`
- `browse_screenshot`, `browse_wait_for_user`, `browse_go_back`
- `browse_extract_file`, `browse_upload_file`
- `browse_close`, `browse_evaluate` (compat stub)

### 7. `tools/firecrawl.ts` — 3 tools
- `firecrawl_scrape` — Single page to markdown
- `firecrawl_crawl` — Multi-page crawl
- `firecrawl_map` — URL discovery

### 8. `tools/memory.ts` — 2 tools
- `memory_save` — Store note/fact to Supermemory
- `memory_search` — Search past memories

## Handler Pattern

Each tool handler changes from:

```typescript
// v1: Promise-based
handler: async (args, ctx) => {
  const { message } = args as { message: string };
  await writeFile(path, JSON.stringify(payload));
  return { content: [{ type: 'text', text: 'Sent.' }] };
}
```

To:

```typescript
// v2: Effect-based
handler: (args, ctx) => Effect.gen(function* () {
  const { message } = args as { message: string };
  const bridge = yield* HostBridge;
  yield* Effect.tryPromise({
    try: () => writeFile(path, JSON.stringify(payload)),
    catch: (err) => new ToolError({ tool: 'send_message', message: String(err) }),
  });
  return { content: [{ type: 'text', text: 'Sent.' }] };
})
```

## Browse Tools — IPC Pattern

Browse tools use a request/response IPC pattern. In v2, the `HostBridge` service encapsulates this:

```typescript
// v1: manual file polling
const reqPath = join(ipcDir, 'browse', `req-${id}.json`);
await writeFile(reqPath, JSON.stringify(request));
// poll for res-${id}.json...

// v2: via HostBridge service
const bridge = yield* HostBridge;
const response = yield* bridge.browseRequest(request);
```

In persistent mode, `HostBridge` sends browse requests over the Unix socket RPC. In one-shot mode, it falls back to file-based IPC.

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
- Sends/receives newline-delimited JSON
- `sendMessage` / `browseRequest` / `emitEvent` map to RPC calls
- Connection lifecycle managed by Layer scope

### HostBridgeOneShot
- Falls back to file-based IPC (write to `/workspace/ipc/`)
- `browseRequest` polls for response files (legacy pattern)
- `emitEvent` writes status files

## Cancellation Service

Already implemented in Phase 1 (`CancellationLive`). Uses `Deferred<void, CancellationError>` as signal + `Fiber.interrupt` for clean cancellation.

## Checklist

- [ ] Extract `communication.ts` (3 tools)
- [ ] Extract `audio.ts` (3 tools)
- [ ] Extract `tasks.ts` (5 tools)
- [ ] Extract `groups.ts` (1 tool)
- [ ] Extract `skills.ts` (3 tools)
- [ ] Extract `browse.ts` (12 tools)
- [ ] Extract `firecrawl.ts` (3 tools)
- [ ] Extract `memory.ts` (2 tools)
- [ ] Update `tools/index.ts` to import and spread all modules
- [ ] Implement `ToolRegistryLive` Layer
- [ ] Implement `HostBridgePersistent` Layer
- [ ] Implement `HostBridgeOneShot` Layer
- [ ] Verify all 22 tools compile with Effect-based handlers
