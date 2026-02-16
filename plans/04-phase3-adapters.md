# Phase 3: Container Agent — Adapters + Entry Point

## Goal

Port the three provider adapters (Claude, OpenAI, MiniMax) to return Effect `Stream<AgentEvent>`. Implement the RPC server and one-shot mode. Wire up the container `index.ts` with full Layer composition.

## Adapter Ports

### ClaudeAdapter (`adapters/claude-adapter.ts`)

**Source**: `container/agent-runner/src/adapters/claude-adapter.ts`

The Claude adapter uses the Claude Agent SDK `query()` which returns an async iterable of events. Port approach:

```typescript
export const ClaudeAdapter: ProviderAdapter = {
  run: (input) =>
    Stream.async<AgentEvent, AdapterError>((emit) => {
      // Create Claude SDK client with MCP tools
      // Call query() with system prompt from PromptBuilder
      // Map SDK events to AgentEvent schema
      // emit.single() for each event
      // emit.end() on completion
    }).pipe(
      Stream.provideService(ToolRegistry, /* ... */),
      Stream.provideService(Cancellation, /* ... */),
    ),
};
```

Key v1 configuration to preserve:
- `allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__nanoclaw__*']`
- `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`
- `settingSources: ['project']` — reads CLAUDE.md from cwd (`/workspace/group`)
- `includePartialMessages: true` — enables streaming thinking events
- `maxThinkingTokens` from `MAX_THINKING_TOKENS` env var (default 10000), disabled if `enableThinking === false`
- **Custom base URL**: Sets `process.env.ANTHROPIC_BASE_URL` env var if `input.baseUrl` provided (SDK reads this internally; no constructor param)
- **Thinking stream**: Yields thinking snapshots every 3s (`THINKING_YIELD_INTERVAL = 3000`), truncates to last 4000 chars (`THINKING_SNAPSHOT_LENGTH = 4000`)

Key event mappings:
- Claude SDK `content_block_delta` + `thinking_delta` -> `AgentEvent.ThinkingDelta`
- Claude SDK `text` content -> `AgentEvent.TextDelta`
- Claude SDK tool use -> `AgentEvent.ToolUseStart` + dispatch via `ToolRegistry` -> `AgentEvent.ToolResult`
- Claude SDK done -> `AgentEvent.Done`

The MCP bridge (`mcp/ipc-mcp.ts`) maps `NanoTool[]` into Claude SDK's MCP server format, same as v1 but using the modular tool registry.

### OpenAIAdapter (`adapters/openai-adapter.ts`)

**Source**: `container/agent-runner/src/adapters/openai-adapter.ts`

The OpenAI adapter runs an agentic function-calling loop (max 50 iterations). Port approach:

```typescript
export const OpenAIAdapter: ProviderAdapter = {
  run: (input) =>
    Stream.asyncScoped<AgentEvent, AdapterError>((emit) => {
      Effect.gen(function* () {
        const registry = yield* ToolRegistry;
        const cancellation = yield* Cancellation;
        const schemas = yield* registry.getToolSchemas;
        // Convert Zod schemas to JSON Schema for OpenAI
        // Loop: call chat completions, check for tool_calls
        // For each tool_call: dispatch via registry, emit events
        // Break on no tool_calls (final response)
        // Respect cancellation.isCancelled between iterations
      });
    }),
};
```

Key differences from v1:
- Tool dispatch via `ToolRegistry.dispatch()` instead of inline handler lookup
- Cancellation check via `Cancellation.isCancelled` instead of file polling
- Session persistence via `HostBridge` (or direct file access for one-shot)

#### OpenAI System Prompt Builder

`buildSystemPrompt(input)` constructs a system prompt by:
1. Starting with a base prompt (date, group info, available tool summary)
2. Loading group `CLAUDE.md` from `/workspace/group/CLAUDE.md`
3. Loading global `CLAUDE.md` from `/workspace/global/CLAUDE.md` for non-main groups
4. Appending tool descriptions as a summary list (name + description for each tool)

This is different from the Claude adapter which uses `settingSources: ['project']` to auto-discover CLAUDE.md.

#### OpenAI XML Conversation Parser

`parseConversationXml(prompt)` is a ~40-line function critical for multi-turn conversation support:
- Extracts the `<messages>...</messages>` XML block from the prompt
- Parses each `<message>` tag with attributes: `role` (user/assistant), `sender`, `time`, `media_type`, `media_path`
- Unescapes XML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`)
- Returns `{ conversationMessages: ParsedConversationMessage[], remainingPrompt: string }`
- The `remainingPrompt` contains non-message blocks (soul, skill, memory) passed as a trailing user message

Both OpenAI and MiniMax adapters import and use this parser.

#### Reasoning Parameter Handling

The OpenAI adapter has sophisticated reasoning parameter support:

- **`resolveReasoningEffort(enableThinking?)`**: Reads `OPENAI_REASONING_EFFORT` env var (default `'medium'`). Returns `'low' | 'medium' | 'high' | undefined`. Returns `undefined` if thinking is disabled.
- **`chooseReasoningParamMode(baseUrl, reasoningEffort)`**: Returns `'reasoning_effort'` (standard), `'reasoning_object'` (OpenRouter — uses `{ reasoning: { effort } }`), or `'none'`.
  - OpenRouter uses `reasoning` object format; others use `reasoning_effort` field
- **Automatic retry**: When API rejects reasoning params (conflict error pattern: `only one of "reasoning" and "reasoning_effort"`), retries with reasoning disabled.

#### Think Tag Stripping

`stripThinkTags(content)` removes `<think>...</think>` blocks from response content. Some models (e.g., kimi-k2.5 via OpenRouter) embed reasoning in these tags within `delta.content` instead of using dedicated reasoning fields. Returns `{ cleaned, thinking }`.

#### Reasoning Delta Extraction

`extractReasoningDelta(delta)` handles 3 provider formats for streaming reasoning:
1. `delta.reasoning` — OpenRouter primary field
2. `delta.reasoning_content` — OpenAI o-series / OpenRouter alias
3. `delta.reasoning_details` — OpenRouter structured array with `type: 'reasoning.text'`

#### Tool Result Handling

- **Truncation**: `MAX_TOOL_RESULT_CHARS = 12,000` chars per tool result to prevent context overflow
- **Screenshot image injection**: After a browse_screenshot tool result, injects a `role: 'user'` message with `image_url` content at `detail: 'low'` (OpenAI `role: 'tool'` only accepts strings)
- **Conversation photo injection**: Photos from XML conversation history injected as `image_url` user messages with `detail: 'auto'`

#### Consecutive Tool Error Recovery

After `MAX_CONSECUTIVE_TOOL_ERRORS = 3` consecutive errors, injects a user message: `"[System: Multiple tool calls failed in a row. Stop retrying failed tools...]"` to break retry loops. Counter resets on success.

#### OpenAI Tools Bridge (`openai-tools.ts`)

`buildOpenAITools()` converts NanoClaw tools to OpenAI function-calling format:
- Uses Zod v4's `z.toJSONSchema()` for schema conversion
- Strips `$schema` meta key (OpenAI expects plain JSON Schema in `parameters`)
- Returns `{ type: 'function', function: { name, description, parameters } }[]`

`executeNanoToolFull(toolName, args, ctx)` returns the full `ToolResult` including optional `imageBase64` and `imageMimeType` fields (used for screenshot vision injection).

### MinimaxAdapter (`adapters/minimax-adapter.ts`)

**Source**: `container/agent-runner/src/adapters/minimax-adapter.ts`

MiniMax uses the Anthropic SDK pointed at `https://api.minimax.io/anthropic`:

```typescript
const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/anthropic',
});
```

Key details:
- Default model: `MiniMax-M2.1`
- API key: `MINIMAX_API_KEY` env var
- `MAX_ITERATIONS = 50`, `DEFAULT_MAX_TOKENS = 8192`
- **Non-streaming**: Uses `client.messages.create()` without streaming
- **Does NOT support vision/images** — no multimodal content injection
- Reuses `buildSystemPrompt()` and `parseConversationXml()` from `openai-adapter.ts`
- Reuses `executeNanoTool()` from `openai-tools.ts` for tool dispatch
- Tool schema conversion uses Zod v4's `z.toJSONSchema()`, strips `$schema`, maps to Anthropic `Tool` format (`{ name, description, input_schema }`)

Port is similar to Claude but targets the MiniMax base URL and uses non-streaming Anthropic SDK messages.

## RPC Server (`rpc/server.ts`)

Effect Layer that creates a Unix domain socket server for persistent mode:

```typescript
export const RpcServerLive: Layer.Layer<RpcServer, RpcError> = Layer.scoped(
  RpcServer,
  Effect.gen(function* () {
    const socketPath = process.env.NANOCLAW_RPC_SOCKET;
    // Create Unix socket server
    // On connection: read newline-delimited JSON
    // Dispatch to handler based on message type
    // Send responses back
    // Scope finalizer: close server, unlink socket
  }),
);
```

### Wire Format (Custom, NOT JSON-RPC)

The v1 wire format uses a **custom protocol** with three message types, NOT JSON-RPC 2.0. There is no `jsonrpc` field:

```typescript
// Request (host -> agent or agent -> host)
{ "type": "request", "id": "req-1", "method": "query", "params": {...} }

// Response
{ "type": "response", "id": "req-1", "result": {...} }
// or error:
{ "type": "response", "id": "req-1", "error": "error message" }

// Event (fire-and-forget, no id)
{ "type": "event", "method": "agent.status", "params": {"type": "text_delta", "text": "Hello"} }
```

TypeScript interfaces from `rpc-protocol.ts`:
```typescript
interface RpcRequestMessage  { type: 'request';  id: string; method: string; params?: unknown; }
interface RpcResponseMessage { type: 'response'; id: string; result?: unknown; error?: string; }
interface RpcEventMessage    { type: 'event';    method: string; params?: unknown; }
type RpcMessage = RpcRequestMessage | RpcResponseMessage | RpcEventMessage;
```

Messages are newline-delimited JSON over Unix domain sockets. The `parseRpcLines()` and `serializeRpcMessage()` functions from `rpc-protocol.ts` handle parsing/serialization with a line buffer for incomplete reads.

## One-Shot Mode (`rpc/oneshot.ts`)

Reads JSON from stdin (between sentinel markers), processes single query, writes result to stdout:

```typescript
export const runOneShot = Effect.gen(function* () {
  const input = yield* readStdinJson();
  const validated = yield* Schema.decodeUnknown(ContainerInput)(input);
  const adapter = createAdapter(validated.provider ?? 'anthropic');

  // Collect stream events, build final output
  const events = yield* Stream.runCollect(adapter.run(toAdapterInput(validated)));
  const output = buildContainerOutput(events);

  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
});
```

### Sentinel Markers

The canonical sentinel markers (shared between host `container-runner.ts` and agent `index.ts`) are:
```
---NANOCLAW_OUTPUT_START---
---NANOCLAW_OUTPUT_END---
```

Both host and agent define these identically. JSON output is extracted between these markers for robust parsing (ignoring any other stdout noise from the container).

## Container Entry Point (`index.ts`)

Wire up with Layer composition:

```typescript
const program = Effect.gen(function* () {
  const forcePersistent = process.env.NANOCLAW_PERSISTENT === '1';
  const isPiped = !process.stdin.isTTY;

  if (forcePersistent || !isPiped) {
    // Persistent mode: start RPC server
    yield* RpcServer.serve();
  } else {
    // One-shot mode: read stdin, process, output
    yield* runOneShot;
  }
});

const MainLayer = Layer.mergeAll(
  ToolRegistryLive,
  PromptBuilderLive,
  CancellationLive,
  StatusEmitterRpc,  // or StatusEmitterFile for one-shot
).pipe(
  Layer.provide(HostBridgePersistent), // or HostBridgeOneShot
);

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
);
```

## Dockerfile Update

Add build step for agent-runner-v2:

```dockerfile
# Build v2 agent runner
COPY container/agent-runner-v2/package.json container/agent-runner-v2/bun.lock /app-v2/
RUN cd /app-v2 && bun install --frozen-lockfile
COPY container/agent-runner-v2/src /app-v2/src
COPY container/agent-runner-v2/tsconfig.json /app-v2/
RUN cd /app-v2 && bun build src/index.ts --outdir dist --target bun

# Entrypoint selects v1 or v2 based on NANOCLAW_AGENT_VERSION env var
```

## Checklist

- [ ] Implement `claude-adapter.ts` — Claude SDK -> Effect Stream, preserve: `allowedTools`, `permissionMode`, `settingSources`, thinking stream, `ANTHROPIC_BASE_URL` env injection
- [ ] Implement `openai-adapter.ts` — Function-calling loop -> Effect Stream, include:
  - [ ] `parseConversationXml()` — XML conversation parser (40+ lines)
  - [ ] `buildSystemPrompt()` — System prompt builder (group + global CLAUDE.md + tool descriptions)
  - [ ] `resolveReasoningEffort()` / `chooseReasoningParamMode()` — Reasoning parameter handling with auto-retry
  - [ ] `stripThinkTags()` — `<think>` tag stripping for kimi-k2.5 etc.
  - [ ] `extractReasoningDelta()` — 3-format reasoning delta extraction
  - [ ] Screenshot image injection (`detail: 'low'`) and conversation photo injection (`detail: 'auto'`)
  - [ ] `MAX_TOOL_RESULT_CHARS = 12,000` truncation
  - [ ] `MAX_CONSECUTIVE_TOOL_ERRORS = 3` recovery (inject system user message)
- [ ] Implement `minimax-adapter.ts` — MiniMax Anthropic-compat, non-streaming, no vision, reuses `buildSystemPrompt`/`parseConversationXml`, `MAX_ITERATIONS=50`, `DEFAULT_MAX_TOKENS=8192`
- [ ] Implement `openai-tools.ts` — Zod v4 `z.toJSONSchema()` bridge, strip `$schema`, `executeNanoToolFull()` with image data
- [ ] Implement `mcp/ipc-mcp.ts` — NanoTool[] -> Claude SDK MCP format
- [ ] Implement `rpc/protocol.ts` — Custom wire format (NOT JSON-RPC): `{ type: 'request'|'response'|'event', id?, method?, params?, result?, error? }`, `parseRpcLines()`, `serializeRpcMessage()`
- [ ] Implement `rpc/server.ts` — Unix socket RPC server as Effect Layer
- [ ] Implement `rpc/oneshot.ts` — Stdin/stdout one-shot mode with `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers
- [ ] Wire up `index.ts` with Layer composition
- [ ] Update `createAdapter` factory to dispatch to all three adapters
- [ ] Update Dockerfile to build both agent-runner and agent-runner-v2
- [ ] Test one-shot mode with JSON input
- [ ] Test persistent mode with RPC client
