# Agent Tool Reference

## Overview

All agent tools are defined in `container/agent-runner/src/tool-registry.ts` using Zod schemas. In persistent mode, tools are executed over a typed Unix-socket RPC channel between host and container. Legacy file-based IPC remains as a compatibility fallback (primarily one-shot mode).

### Tool Availability by Provider

- **Anthropic (Claude):** IPC tools are exposed as an MCP server (`ipc-mcp.ts`). Agents also have access to built-in Claude Code tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.
- **OpenAI:** IPC tools are exposed via function calling (Zod schemas converted to JSON Schema). No filesystem tools (Bash, Read, Write, Edit, etc.) are available.

### Authorization

- **Main group:** Full access to all tools. Can register new groups, schedule tasks for any group, and see all tasks.
- **Non-main groups:** Restricted. Can only send messages to their own chat, manage their own tasks, and cannot register groups. The `target_group` parameter on `schedule_task` is ignored for non-main groups.

### IPC Mechanisms

| Category | Mechanism | Directory | Description |
|---|---|---|---|
| Communication | Fire-and-forget | `/workspace/ipc/messages/` | Agent writes JSON file; host polls, processes, deletes |
| Task Scheduling | Fire-and-forget | `/workspace/ipc/tasks/` | Agent writes JSON file; host polls, processes, deletes |
| Group Management | Fire-and-forget | `/workspace/ipc/tasks/` | Uses the tasks IPC directory |
| Skills | Filesystem + IPC | `/workspace/group/skills/` | JSON files on disk; IPC notification to host for command re-registration |
| Browser Automation | Request/Response | `/workspace/ipc/browse/` | Agent writes `req-{id}.json`, polls for `res-{id}.json`; host processes request and writes response atomically |
| Web Crawling | Direct API | N/A | Calls Firecrawl API directly from the container (no IPC) |
| Long-term Memory | Direct API | N/A | Calls Supermemory API directly from the container (no IPC) |

---

## Communication Tools

IPC mechanism: fire-and-forget via `/workspace/ipc/messages/`.

### send_message

Send a message to the current chat. Use this to proactively share information or updates.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | Yes | The message text to send |

### send_file

Send a file/document to the current chat via Telegram. Use this to share downloaded files, generated documents, or any file accessible to the agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Absolute path to the file inside the container (e.g., `/workspace/group/media/report.pdf`). The file must exist at this path. |
| `caption` | string | No | Optional caption to send with the file |

**Notes:**
- The path must point to an existing file inside the container. Returns an error if the file is not found.

### send_voice

Send a voice message to the current chat using text-to-speech. The text will be synthesized into expressive speech and sent as a Telegram voice message.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | Yes | The text to speak as a voice message |
| `emotion` | string | No | Emotion for the voice (e.g., `"happy"`, `"sad:2"`, `"whisper:3"`). Auto-detected from text if omitted. |

**Emotion format:** `"emotion"` or `"emotion:intensity"` (e.g., `"happy"`, `"sad:2"`, `"whisper:3"`).

Available emotions:
- **Basic:** neutral, happy[1-3], sad[1-3], angry[1-4], fear[1-4], surprise[1-2]
- **Nuanced:** shy[1-3], caring[1-3], jealous[1-3], tsun[1-3], embarrassed, lonely, awkward, protective, relieved[1-2], worried[1-2], anxious, annoyed[1-4], frustrated, disappointed, sarcastic, playful[1-3], proud, pout, cold[1-3], awe
- **Special:** whisper[1-3], tired[1-2], sleepy, breathy, monotone, firm, mumbling

Higher numbers indicate stronger intensity. Keep text under ~500 characters for best quality.

**Environment variables:** Requires `FREYA_TTS_ENABLED=true` and `FREYA_API_KEY` to be set.

---

## Task Scheduling Tools

IPC mechanism: fire-and-forget via `/workspace/ipc/tasks/`.

### schedule_task

Schedule a recurring or one-time task. The task runs as a full agent with access to all tools.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | What the agent should do when the task runs. For isolated mode, include all necessary context here. |
| `schedule_type` | `"cron"` \| `"interval"` \| `"once"` | Yes | `cron` = recurring at specific times, `interval` = recurring every N ms, `once` = run once at specific time |
| `schedule_value` | string | Yes | Depends on `schedule_type` (see format below) |
| `context_mode` | `"group"` \| `"isolated"` | No | `group` (default) = runs with chat history and memory; `isolated` = fresh session with no conversation history |
| `target_group` | string | No | Target group folder. Main group only; ignored for non-main groups. Defaults to current group. |

**Schedule value format (all times are local timezone):**

| Type | Format | Example |
|---|---|---|
| `cron` | Standard cron expression | `"0 9 * * *"` (daily at 9am), `"*/5 * * * *"` (every 5 min) |
| `interval` | Milliseconds between runs | `"300000"` (5 minutes), `"3600000"` (1 hour) |
| `once` | Local ISO 8601 timestamp (no `Z` suffix) | `"2026-02-01T15:30:00"` |

**Context mode guidance:**
- `"group"` (recommended for most tasks): Use for tasks needing conversation context, user preferences, or previous interactions.
- `"isolated"`: Use for self-contained tasks. Include all necessary context in the prompt.

**Authorization:** Non-main groups can only schedule tasks for themselves; `target_group` is silently overridden to the current group.

**Validation:** The handler validates `schedule_value` before writing the IPC file. Invalid cron expressions, non-positive intervals, and unparseable timestamps return errors.

### list_tasks

List all scheduled tasks.

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

**Authorization:** Main group sees all tasks across all groups. Non-main groups see only their own tasks.

**Notes:** Reads from `/workspace/ipc/current_tasks.json`, a snapshot file written by the host process.

### pause_task

Pause a scheduled task. It will not run until resumed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | Yes | The task ID to pause |

### resume_task

Resume a paused task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | Yes | The task ID to resume |

### cancel_task

Cancel and delete a scheduled task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | Yes | The task ID to cancel |

---

## Group Management Tools

IPC mechanism: fire-and-forget via `/workspace/ipc/tasks/`.

### register_group

Register a new Telegram chat so the agent can respond to messages there. **Main group only.**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jid` | string | Yes | The chat identifier (e.g., `"tg:-1001234567890"`) |
| `name` | string | Yes | Display name for the group |
| `folder` | string | Yes | Folder name for group files (lowercase, hyphens, e.g., `"family-chat"`) |
| `trigger` | string | Yes | Trigger word (e.g., `"@Andy"`) |
| `provider` | string | No | AI provider for this group (e.g., `"anthropic"`, `"openai"`). Defaults to the system default. |
| `model` | string | No | Model to use for this group (e.g., `"gpt-4o"`, `"claude-sonnet-4-20250514"`). Defaults to the provider default. |

**Authorization:** Returns an error if called from a non-main group.

**Notes:** Use `available_groups.json` (written by the host to the IPC directory) to find chat IDs of unregistered groups.

---

## Skill Tools

IPC mechanism: fire-and-forget via `/workspace/ipc/tasks/` (for `store_skill` and `delete_skill` notifications); filesystem for storage.

Skills are reusable workflows that become Telegram slash commands. When a user invokes a stored skill, the instructions guide a fresh agent session through the workflow automatically.

### store_skill

Save a reusable skill (workflow) that becomes a Telegram `/command`. Write clear, step-by-step instructions that a fresh agent session can follow. If a skill with the same name already exists, it will be overwritten.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Skill name (lowercase, hyphens, used as the `/command` name, 1-32 chars, must match `^[a-z][a-z0-9_]{0,31}$`) |
| `description` | string | Yes | Short description shown in Telegram command list (max 256 chars) |
| `instructions` | string | Yes | Detailed step-by-step instructions the agent follows when the skill is invoked |
| `parameters` | string | No | Description of parameters the skill accepts (shown to users) |

**Notes:** Writes a JSON file to `/workspace/group/skills/{name}.json` and notifies the host to re-register Telegram commands.

### list_skills

List all stored skills for the current group.

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

### delete_skill

Delete a stored skill. Removes it from Telegram commands.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | The skill name to delete |

---

## Web Crawling Tools (Firecrawl)

IPC mechanism: **None (direct API calls).** These tools call the Firecrawl REST API directly from within the container.

**Environment variable required:** `FIRECRAWL_API_KEY`. All three tools return an error if this key is not set.

### firecrawl_scrape

Scrape a single URL and return its content as markdown. Useful for reading web pages, articles, documentation, etc.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to scrape |
| `formats` | string[] | No | Output formats (default: `["markdown"]`) |

**Notes:** Response content is truncated at 50KB.

### firecrawl_crawl

Crawl a website starting from a URL, following links up to a depth limit. Returns markdown content for each page found. Useful for indexing documentation sites or exploring a domain.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The starting URL to crawl |
| `limit` | number | No | Max number of pages to crawl (default: 10) |
| `maxDepth` | number | No | Max link depth to follow (default: 2) |

**Notes:**
- Starts an asynchronous crawl job and polls for completion.
- Poll timeout: 120 seconds.
- Response content is truncated at 100KB (pages are removed from the end until under the limit).

### firecrawl_map

Discover all URLs on a website. Returns a list of URLs found on the domain. Useful for understanding site structure before crawling or scraping specific pages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to map |

---

## Long-term Memory Tools (Supermemory)

IPC mechanism: **None (direct API calls).** These tools use the Supermemory SDK directly from within the container.

**Environment variable required:** One of `SUPERMEMORY_API_KEY`, `SUPERMEMORY_OPENCLAW_API_KEY`, or `SUPERMEMORY_CC_API_KEY` (checked in that order). Both tools return an error if no key is found.

**Scoping:** Memories are scoped per group using container tags (`nanoclaw_{groupFolder}`).

### memory_save

Save a note, fact, or piece of information to long-term memory. Use this to explicitly remember important context, preferences, or decisions that should persist across conversations.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | The text content to save to memory. Can be a fact, note, summary, or any information worth remembering. |
| `metadata` | Record<string, string> | No | Optional key-value metadata (e.g., `{"category": "preference", "topic": "coding"}`) |

### memory_search

Search long-term memory for relevant past information, conversations, and facts. Use this to recall context from previous conversations or explicitly saved memories.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Natural language search query describing what you want to recall |
| `limit` | number | No | Maximum number of results to return (default: 10) |

**Notes:** Uses hybrid search mode. Results include a relevance similarity score.

---

## Browser Automation Tools (CUA Sandbox)

IPC mechanism: request/response via `/workspace/ipc/browse/`. The agent writes a `req-{id}.json` file, then polls for the corresponding `res-{id}.json` response from the host. Default poll timeout is 60 seconds unless otherwise noted.

The CUA sandbox is a persistent Docker sidecar running a desktop environment (`trycua/cua-xfce:latest`). It starts lazily on first browse tool call and stops after 30 minutes of idle time.

### browse_navigate

Navigate the sandboxed browser/desktop to a URL.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to navigate to |

### browse_snapshot

Get an accessibility tree / simplified snapshot of the current page or desktop UI. Useful for understanding visible structure and finding elements to interact with.

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

### browse_click

Click an element by human-readable description text.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | Yes | Description text to click (e.g., `"text=Sign In"`, `"Search"`). CSS-like selectors are treated as best-effort hints. |

### browse_click_xy

Click at exact pixel coordinates on the screen. Use this when `browse_click` fails to find an element, or when you know the coordinates from a screenshot.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | integer | Yes | X coordinate in pixels from left edge of screen |
| `y` | integer | Yes | Y coordinate in pixels from top edge of screen |

### browse_fill

Fill a form field with a value. Finds the target element by description and types the value.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | Yes | Description text of the input field (e.g., `"Email"`, `"Search"`). CSS-like selectors are treated as best-effort hints. |
| `value` | string | Yes | The value to type into the field |

### browse_type_at_xy

Click at exact pixel coordinates then type text. Use when `browse_fill` fails to find the input field.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | integer | Yes | X coordinate of the input field in pixels |
| `y` | integer | Yes | Y coordinate of the input field in pixels |
| `value` | string | Yes | The text to type into the field |

### browse_scroll

Scroll the current page by delta values.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dy` | integer | Yes | Vertical scroll delta. Positive = down, negative = up. |
| `dx` | integer | No | Horizontal scroll delta. Positive = right, negative = left. |

### browse_screenshot

Take a screenshot of the current browser page. Returns the saved image path plus labeled UI elements mapped to grid cells. The screenshot is also sent as a Telegram photo.

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

**Notes:** If the text summary is insufficient, use the Read tool on the returned screenshot file path to visually inspect the image.

### browse_wait_for_user

Ask the user to take over the sandbox directly (e.g., to log in), then wait for control to return. Sends a chat message with a takeover web URL and instructions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | string | Yes | Message to send to the user explaining what they need to do in takeover mode (e.g., `"Please log in and click Return Control To Agent when done"`) |

**Notes:** Poll timeout is extended to 300 seconds (5 minutes) for this tool.

### browse_go_back

Navigate back in browser history (like clicking the back button).

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

### browse_evaluate

Execute a JavaScript expression on the current page and return the result.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | Yes | JavaScript expression to evaluate (e.g., `"document.title"`, `"window.location.href"`) |

**Notes:** Currently unsupported in CUA sandbox mode and returns an error. Present for backward compatibility only.

### browse_close

Close the current browser page/tab.

| Parameter | Type | Required | Description |
|---|---|---|---|
| *(none)* | | | |

### browse_extract_file

Extract/download a file from the CUA sandbox desktop to the agent container. Returns the local file path which can then be sent to the user via `send_file`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Absolute path to the file inside the CUA sandbox (e.g., `"/root/Downloads/report.pdf"`, `"~/Documents/data.csv"`) |

**Notes:** Poll timeout is extended to 120 seconds for this tool.

### browse_upload_file

Upload a file from the agent container into the CUA sandbox desktop. Useful for making files received from Telegram available in the browser environment.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source_path` | string | Yes | Path to the file inside the agent container (e.g., `"/workspace/group/media/document.pdf"`) |
| `destination_path` | string | No | Destination path inside the CUA sandbox. Defaults to `~/Downloads/{filename}`. |

**Notes:** Poll timeout is extended to 120 seconds for this tool.

---

## Built-in Claude Tools (Anthropic Provider Only)

When using the Anthropic (Claude) provider, agents also have access to the following built-in Claude Code tools. These are provided by the Claude Agent SDK and are not available with the OpenAI provider.

| Tool | Description |
|---|---|
| `Bash` | Execute shell commands |
| `Read` | Read file contents (also supports image/vision inspection) |
| `Write` | Write or overwrite file contents |
| `Edit` | Make targeted edits to existing files |
| `Glob` | Find files by glob pattern |
| `Grep` | Search file contents with regex |
| `WebSearch` | Search the web |
| `WebFetch` | Fetch and process web page content |
