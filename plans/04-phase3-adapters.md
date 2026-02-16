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

Key mappings:
- Claude SDK `text_delta` -> `AgentEvent.TextDelta`
- Claude SDK `thinking_delta` -> `AgentEvent.ThinkingDelta`
- Claude SDK `tool_use` -> `AgentEvent.ToolUseStart` + dispatch via `ToolRegistry` -> `AgentEvent.ToolResult`
- Claude SDK `done` -> `AgentEvent.Done`

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

### MinimaxAdapter (`adapters/minimax-adapter.ts`)

MiniMax uses an Anthropic-compatible API (same message format). Port is similar to Claude but targets the MiniMax base URL.

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

Wire format (unchanged from v1):
```
{"jsonrpc":"2.0","method":"query","id":1,"params":{...}}\n
{"jsonrpc":"2.0","result":{...},"id":1}\n
{"jsonrpc":"2.0","method":"event","params":{"type":"text_delta","text":"Hello"}}\n
```

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

- [ ] Implement `claude-adapter.ts` — Claude SDK -> Effect Stream
- [ ] Implement `openai-adapter.ts` — Function-calling loop -> Effect Stream
- [ ] Implement `minimax-adapter.ts` — MiniMax Anthropic-compat -> Effect Stream
- [ ] Implement `mcp/ipc-mcp.ts` — NanoTool[] -> Claude SDK MCP format
- [ ] Implement `rpc/protocol.ts` — Serialize/parse (same wire format as v1)
- [ ] Implement `rpc/server.ts` — Unix socket RPC server as Effect Layer
- [ ] Implement `rpc/oneshot.ts` — Stdin/stdout one-shot mode
- [ ] Wire up `index.ts` with Layer composition
- [ ] Update `createAdapter` factory to dispatch to all three adapters
- [ ] Update Dockerfile to build both agent-runner and agent-runner-v2
- [ ] Test one-shot mode with JSON input
- [ ] Test persistent mode with RPC client
