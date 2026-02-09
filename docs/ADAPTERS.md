# Multi-Provider Adapter System

## Overview

NanoClaw supports multiple AI providers through an adapter pattern implemented in `container/agent-runner/src/`. Each Telegram group can independently use a different provider and model, configured at registration time or via environment variable defaults. The adapter system decouples tool definitions from SDK-specific integration: tools are defined once in a provider-agnostic registry, and each adapter wraps them for its own SDK format.

Currently supported providers:
- **Anthropic** (Claude Agent SDK) -- full-featured, with filesystem tools, web tools, MCP server integration, and SDK-managed sessions
- **OpenAI** (Chat Completions API) -- function-calling loop with IPC tools only, manual session persistence

## Architecture

### File Structure

```
container/agent-runner/src/
  index.ts                      # Entry point: reads input, calls createAdapter(), runs adapter
  types.ts                      # Shared interfaces: ProviderAdapter, AgentEvent, AdapterInput, NanoTool
  tool-registry.ts              # Provider-agnostic tool definitions (NANOCLAW_TOOLS array)
  ipc-mcp.ts                    # Wraps tool registry into Claude Agent SDK MCP server format
  adapters/
    index.ts                    # Factory: createAdapter(provider) -> ProviderAdapter
    claude-adapter.ts           # Anthropic implementation (Claude Agent SDK)
    openai-adapter.ts           # OpenAI implementation (Chat Completions + function calling)
    openai-session.ts           # OpenAI conversation history persistence
    openai-tools.ts             # Zod-to-JSON Schema bridge for OpenAI function calling
```

### Request Flow

```
Host Process
  |
  |  Spawns Docker container, sends ContainerInput as JSON on stdin
  |  (or writes to IPC agent-input dir in persistent mode)
  v
index.ts
  |-- Reads ContainerInput (stdin or file)
  |-- preparePrompt(): injects SOUL.md, scheduled task prefix
  |-- createAdapter(provider): returns ClaudeAdapter or OpenAIAdapter
  |-- Constructs AdapterInput from ContainerInput
  |-- Iterates adapter.run(adapterInput) AsyncGenerator<AgentEvent>
  |-- Collects session_init, result, tool_start, tool_progress, adapter_stderr events
  |-- Writes ContainerOutput as JSON on stdout (or to agent-output file)
  v
Host Process reads output, updates session, sends result to Telegram
```

## Core Interfaces

All interfaces are defined in `container/agent-runner/src/types.ts`.

### ProviderAdapter

The contract every provider must implement:

```typescript
export interface ProviderAdapter {
  run(input: AdapterInput): AsyncGenerator<AgentEvent>;
}
```

The `run()` method receives an `AdapterInput` and yields an async stream of `AgentEvent` values. The caller iterates this stream to collect the session ID, final result, and tool activity events.

### AgentEvent

Normalized events emitted by all adapters, consumed by `index.ts`:

```typescript
export type AgentEvent =
  | { type: 'session_init'; sessionId: string }
  | { type: 'result'; result: string }
  | { type: 'tool_start'; toolName: string; preview: string }
  | { type: 'tool_progress'; toolName: string; elapsedSeconds?: number }
  | { type: 'adapter_stderr'; message: string };
```

| Event | Purpose |
|---|---|
| `session_init` | Emitted once at start with the session ID (new or resumed) |
| `result` | The final text response from the model |
| `tool_start` | A tool call has begun; includes name and argument preview (200 chars) |
| `tool_progress` | Periodic progress for long-running tools (Claude SDK only) |
| `adapter_stderr` | Stderr output from the underlying CLI/process (Claude SDK only) |

### AdapterInput

Input passed to `ProviderAdapter.run()`:

```typescript
export interface AdapterInput {
  prompt: string;            // User message (with SOUL.md and task prefix already injected)
  sessionId?: string;        // Resume an existing session (undefined = new session)
  model?: string;            // Model override (e.g. "gpt-4o", "claude-sonnet-4-5-20250929")
  groupFolder: string;       // Group folder name (e.g. "main", "family-chat")
  isMain: boolean;           // Whether this is the main (privileged) group
  isScheduledTask?: boolean; // True when running from the task scheduler
  assistantName?: string;    // Display name for the assistant (e.g. "Andy")
  ipcContext: IpcMcpContext; // Authorization context for tool handlers
}
```

### IpcMcpContext

Context passed to every tool handler for IPC authorization and routing:

```typescript
export interface IpcMcpContext {
  chatJid: string;       // Target chat identifier (e.g. "tg:-1001234567890")
  groupFolder: string;   // Source group folder
  isMain: boolean;       // Main group has full access; others are restricted
}
```

### NanoTool

Provider-agnostic tool definition used by the tool registry:

```typescript
export interface NanoTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;  // Zod schema for input validation
  handler: (args: Record<string, unknown>, ctx: IpcMcpContext) => Promise<ToolResult>;
}
```

Each tool has a Zod schema that serves as the single source of truth for input validation. Adapters convert this schema to their SDK-specific format:
- **Claude**: `schema.shape` is passed to the Claude Agent SDK's `tool()` helper via MCP
- **OpenAI**: `z.toJSONSchema(schema)` converts the Zod schema to JSON Schema for function calling

## Configuring Per-Group Providers

### Registration

Each group's AI provider is stored in `data/registered_groups.json` as an optional `providerConfig` field:

```json
{
  "tg:-1001234567890": {
    "name": "Family Chat",
    "folder": "family-chat",
    "trigger": "@Andy",
    "providerConfig": {
      "provider": "openai",
      "model": "gpt-4o"
    }
  }
}
```

The `register_group` tool accepts optional `provider` and `model` parameters. When provided, they are stored as `providerConfig` on the group registration.

### Resolution Order

Provider and model are resolved with a fallback chain:

```
group.providerConfig?.provider  →  DEFAULT_PROVIDER env var  →  'anthropic'
group.providerConfig?.model     →  DEFAULT_MODEL env var     →  undefined (use provider default)
```

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DEFAULT_PROVIDER` | `anthropic` | Fallback provider when group has no `providerConfig` |
| `DEFAULT_MODEL` | `''` (empty) | Fallback model; empty string means use the provider's default |

### Adapter Factory

The factory in `container/agent-runner/src/adapters/index.ts` is a simple switch:

```typescript
export function createAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
    default:
      return new ClaudeAdapter();
  }
}
```

Unknown provider strings fall through to `ClaudeAdapter` as the default.

## Claude Adapter

**File:** `container/agent-runner/src/adapters/claude-adapter.ts`

The Claude adapter wraps the `@anthropic-ai/claude-agent-sdk` `query()` function and normalizes its streaming events into `AgentEvent`.

### SDK Integration

```typescript
for await (const message of query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    resume: input.sessionId,
    model: input.model,
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'mcp__nanoclaw__*',
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    mcpServers: { nanoclaw: ipcMcp },
    hooks: { PreCompact: [{ hooks: [createPreCompactHook()] }] },
  },
})) {
  // Map SDK events → AgentEvent stream
}
```

### MCP Tool Server (`ipc-mcp.ts`)

The NanoClaw tool registry is exposed to the Claude Agent SDK as an MCP server named `nanoclaw`. The `createIpcMcp()` function wraps each `NanoTool` using the SDK's `tool()` helper:

```typescript
export function createIpcMcp(ctx: IpcMcpContext) {
  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: NANOCLAW_TOOLS.map((t) =>
      tool(t.name, t.description, t.schema.shape, async (args) => {
        const result = await t.handler(args, ctx);
        return {
          content: [{ type: 'text', text: result.content }],
          isError: result.isError,
        };
      })
    ),
  });
}
```

Tools are accessed by the model as `mcp__nanoclaw__<tool_name>` (matched by the `mcp__nanoclaw__*` glob in `allowedTools`).

### Built-in Tools

The Claude adapter enables these built-in Claude Agent SDK tools via `allowedTools`:

- **Bash** -- Shell command execution (sandboxed inside container)
- **Read**, **Write**, **Edit** -- File operations
- **Glob**, **Grep** -- File search
- **WebSearch**, **WebFetch** -- Web access

These are exclusive to the Claude adapter; they are provided by the Claude CLI and are not available through the OpenAI adapter.

### PreCompact Hook

The Claude SDK calls the PreCompact hook when the conversation context is about to be compacted. The adapter uses this to archive the conversation transcript:

1. Reads the JSONL transcript file from the SDK
2. Parses user/assistant messages
3. Looks up a session summary from `sessions-index.json`
4. Writes a formatted Markdown file to `/workspace/group/conversations/`

This preserves conversation history in a human-readable format before the SDK discards older context.

### Session Management

Session resumption uses the Claude SDK's built-in mechanism: `options.resume` receives the `sessionId` from the previous run. The SDK manages the full conversation state. Session data is stored in the per-group `.claude` directory (`data/sessions/{folder}/.claude/` on the host).

## OpenAI Adapter

**File:** `container/agent-runner/src/adapters/openai-adapter.ts`

The OpenAI adapter implements an agentic loop using the OpenAI Chat Completions API with function calling.

### Agentic Loop

The adapter runs a loop with a hard cap of `MAX_ITERATIONS = 50`:

```
1. Build system prompt (identity + CLAUDE.md + global CLAUDE.md + tool descriptions)
2. Load conversation history from session file (if resuming)
3. Append user message
4. LOOP (max 50 iterations):
   a. Send messages to OpenAI Chat Completions API
   b. If response has no tool_calls → yield result, break
   c. For each tool_call:
      - yield tool_start event
      - Parse arguments
      - Execute via executeNanoTool()
      - Append tool result to messages
   d. Continue loop
5. Save conversation history to session file
```

### Tool Integration (`openai-tools.ts`)

NanoClaw tools are converted to OpenAI function-calling format using Zod v4's `z.toJSONSchema()`:

```typescript
export function buildOpenAITools(): OpenAIFunctionTool[] {
  return NANOCLAW_TOOLS.map((t) => {
    const jsonSchema = z.toJSONSchema(t.schema);
    const { $schema: _, ...parameters } = jsonSchema;
    return {
      type: 'function',
      function: { name: t.name, description: t.description, parameters },
    };
  });
}
```

Tool execution routes calls back to the registered handlers:

```typescript
export async function executeNanoTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: IpcMcpContext,
): Promise<string> {
  const tool = NANOCLAW_TOOLS.find((t) => t.name === toolName);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  const result = await tool.handler(args, ctx);
  return result.content;
}
```

### System Prompt Construction

The `buildSystemPrompt()` function assembles the system message from multiple sources:

1. Base identity: `You are {assistantName}, a helpful AI assistant.`
2. Group-specific `CLAUDE.md` (from `/workspace/group/CLAUDE.md`)
3. Global `CLAUDE.md` (from `/workspace/global/CLAUDE.md`, non-main groups only)
4. Tool descriptions: a bulleted list of all NanoClaw tools with names and descriptions

### Session Persistence (`openai-session.ts`)

OpenAI sessions are persisted as JSON files in `/workspace/group/.openai-sessions/`.

| Constant | Value | Purpose |
|---|---|---|
| `MAX_MESSAGES` | `100` | Trim threshold |

**Session ID format:** `openai-{timestamp}-{random6chars}`

**Auto-trimming:** When messages exceed `MAX_MESSAGES` (100), the save function keeps the first message (system prompt) plus the most recent 99 messages.

**Atomic writes:** Session files use temp + rename to prevent corruption.

### Default Model

When no model is specified, the OpenAI adapter defaults to `gpt-4o`.

## Provider Comparison

| Feature | Claude (Anthropic) | OpenAI |
|---|---|---|
| **SDK** | `@anthropic-ai/claude-agent-sdk` `query()` | `openai` Chat Completions API |
| **Filesystem tools** | Bash, Read, Write, Edit, Glob, Grep | None |
| **Web tools** | WebSearch, WebFetch | None |
| **IPC tools** | Via MCP server (`mcp__nanoclaw__*`) | Via function calling |
| **Tool schema format** | Zod `.shape` passed to SDK `tool()` helper | Zod → JSON Schema via `z.toJSONSchema()` |
| **Session management** | Claude SDK sessions (`options.resume`) | JSON file persistence (`.openai-sessions/`) |
| **Context handling** | SDK-managed compaction (PreCompact hook) | Manual trim: keep first + last 99 messages |
| **Max iterations** | SDK-managed (no explicit cap) | 50 (`MAX_ITERATIONS`) |
| **Conversation archiving** | PreCompact hook writes Markdown transcripts | No archiving |
| **Default model** | SDK default (determined by Claude CLI) | `gpt-4o` |
| **CLAUDE.md loading** | Via `settingSources: ['project']` (SDK auto-discovers) | Manually read and injected into system prompt |
| **SOUL.md loading** | Injected by `index.ts` `preparePrompt()` (shared) | Injected by `index.ts` `preparePrompt()` (shared) |
| **Auth env var** | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |

## Adding a New Provider

To add support for a new AI provider (e.g., Google Gemini, Mistral, a local model):

### 1. Create the Adapter File

Create `container/agent-runner/src/adapters/your-adapter.ts`:

```typescript
import type { ProviderAdapter, AdapterInput, AgentEvent } from '../types.js';

export class YourAdapter implements ProviderAdapter {
  async *run(input: AdapterInput): AsyncGenerator<AgentEvent> {
    // 1. Generate or reuse a session ID
    const sessionId = input.sessionId || generateNewId();
    yield { type: 'session_init', sessionId };

    // 2. Build your SDK client and prepare the prompt
    // 3. Convert NanoTool definitions to your SDK's format
    // 4. Run the model, handle tool calls in a loop
    // 5. Yield tool_start events for each tool invocation
    // 6. Yield the final result
    yield { type: 'result', result: finalResponse };
  }
}
```

### 2. Implement Tool Integration

Use the existing `NANOCLAW_TOOLS` array from `tool-registry.ts` -- do not redefine tools:

```typescript
import { NANOCLAW_TOOLS } from '../tool-registry.js';

// Convert tools to your format
const tools = NANOCLAW_TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  parameters: convertZodSchema(t.schema),
}));

// Execute a tool call
const tool = NANOCLAW_TOOLS.find(t => t.name === toolName);
const result = await tool.handler(parsedArgs, input.ipcContext);
```

### 3. Handle Session Persistence

If your provider does not manage sessions natively, adopt the pattern from `openai-session.ts`:
- Store conversation history as JSON files
- Use atomic file writes (temp + rename) to prevent corruption
- Implement auto-trimming to bound memory usage
- Store sessions in a provider-specific directory (e.g., `/workspace/group/.your-sessions/`)

### 4. Register in the Factory

Add your provider to the switch in `container/agent-runner/src/adapters/index.ts`:

```typescript
import { YourAdapter } from './your-adapter.js';

export function createAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case 'your-provider':
      return new YourAdapter();
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
    default:
      return new ClaudeAdapter();
  }
}
```

### 5. Update Host-Side Types

Add your provider string to `ProviderConfig` in `src/types.ts`:

```typescript
export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'your-provider';
  model?: string;
}
```

### 6. Mount API Key

If your provider needs an API key, add it to the `extraVars` array in `src/container-runner.ts:resolveCredentials()` so it gets mounted into the container's env file.

### 7. Test

1. Register a group with your provider: `register_group` with `provider: 'your-provider'`
2. Or set `DEFAULT_PROVIDER=your-provider` to make it the default
3. Send a message and verify the adapter runs correctly
4. Test tool calling: ensure IPC tools work through your adapter
5. Test session resumption: send multiple messages and verify continuity

### Checklist

- [ ] Adapter implements `ProviderAdapter` with `async *run()` returning `AsyncGenerator<AgentEvent>`
- [ ] Yields `session_init` event at the start of every run
- [ ] Yields `result` event with the final text response
- [ ] Yields `tool_start` events for each tool invocation (for status reporting)
- [ ] Uses `NANOCLAW_TOOLS` from the shared registry (no duplicate tool definitions)
- [ ] Passes `input.ipcContext` to tool handlers for authorization
- [ ] Handles session persistence (new sessions and resumption)
- [ ] Registered in the `createAdapter()` factory
- [ ] Provider string added to `ProviderConfig` type
- [ ] API key mounted into container environment
