# NanoClaw Dashboard

## Overview

The NanoClaw Dashboard is a web-based monitoring and management UI for the NanoClaw host process. It provides real-time log streaming, container execution history, scheduled task monitoring, and file management for both agent groups and the CUA browser sandbox.

Key characteristics:

- **Telegram Mini App** -- Designed to be opened directly inside Telegram via the chat menu button or the `/dashboard` command.
- **Owner-only access** -- Authenticated against `TELEGRAM_OWNER_ID` using Telegram's WebApp `initData` HMAC verification.
- **Single-page app** -- All HTML, CSS, and JS are embedded in `dashboard-server.ts` and served by the host process. No external build step or static file directory.
- **Bun.serve** -- Runs on the host process using Bun's built-in HTTP server, bound to `127.0.0.1` by default.

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DASHBOARD_ENABLED` | `true` (disabled only when set to `"false"`) | Enable or disable the dashboard server |
| `DASHBOARD_PORT` | `7789` | HTTP port the dashboard listens on |
| `DASHBOARD_TLS_CERT` | (empty) | Path to TLS certificate file for direct HTTPS |
| `DASHBOARD_TLS_KEY` | (empty) | Path to TLS private key file for direct HTTPS |
| `DASHBOARD_URL` | (empty) | Explicit HTTPS URL override for Telegram Mini App links |
| `DASHBOARD_HTTPS_PORT` | `7790` | HTTPS port used by Tailscale serve reverse proxy |
| `LOG_RETENTION_DAYS` | `7` | Number of days to retain logs in the SQLite database |

### URL Resolution

The dashboard URL used for Telegram integration is resolved with this priority:

1. `DASHBOARD_URL` environment variable (if set)
2. Tailscale serve HTTPS URL (if Tailscale is enabled and FQDN is detected)
3. Fallback: `http://<host-ip>:<DASHBOARD_PORT>`

When `DASHBOARD_TLS_CERT` and `DASHBOARD_TLS_KEY` are both set and the files exist, Bun.serve uses them directly for TLS termination.

### Limits

| Constant | Value | Purpose |
|---|---|---|
| `MAX_UPLOAD_SIZE` | 50 MB | Maximum file upload size (agent and CUA) |
| `MAX_DOWNLOAD_SIZE` | 100 MB | Maximum file download size |
| `MAX_PREVIEW_TEXT` | 10 KB | Maximum text file size for inline preview |
| `MAX_PREVIEW_IMAGE` | 2 MB | Maximum image file size for inline base64 preview |

### Protected Files

The files `CLAUDE.md` and `SOUL.md` cannot be deleted through the file management API. Attempting to delete them returns a `403` response.

### CUA Safe Roots

CUA sandbox file operations are restricted to these path prefixes: `/home/`, `/tmp/`, `/root/`, `/var/`, `/opt/`, plus the root `/` and home shorthand `~/`.

## Authentication

### Flow

1. The Telegram Mini App opens the dashboard at `/app`.
2. The embedded JavaScript calls `GET /api/auth?initData=<encoded>` with the Telegram WebApp `initData` string.
3. The server validates the HMAC-SHA256 signature:
   - Computes `secret_key = HMAC_SHA256("WebAppData", TELEGRAM_BOT_TOKEN)`
   - Computes `hash = HMAC_SHA256(secret_key, data_check_string)` where `data_check_string` is the alphabetically sorted, newline-joined `key=value` pairs (excluding `hash`)
   - Compares the computed hash against the provided `hash` using timing-safe comparison
4. Checks that `auth_date` is not older than 1 hour.
5. Extracts the `user` JSON from `initData` and verifies that `user.id` matches `TELEGRAM_OWNER_ID`.
6. On success, creates a session and returns a bearer token (UUID) with an expiration timestamp.

### Token Management

- **Token format**: UUID v4 (generated via `crypto.randomUUID()`)
- **Session TTL**: 24 hours
- **Storage**: In-memory `Map` (sessions do not persist across restarts)
- **Cleanup**: Expired sessions are pruned every 60 minutes
- **Usage**: All authenticated API requests must include the token as either:
  - `Authorization: Bearer <token>` header, or
  - `?token=<token>` query parameter

### Unauthenticated Endpoints

- `GET /healthz` -- Health check
- `GET /` and `GET /app` -- Serves the dashboard HTML (the page handles auth via JavaScript)
- `GET /api/auth` -- The authentication endpoint itself

All other `/api/*` endpoints return `401` if no valid token is provided.

## API Reference

### Authentication

#### `GET /api/auth`

Validate Telegram `initData` and obtain a bearer token.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `initData` | Yes | URL-encoded Telegram WebApp `initData` string |

**Success response (200):**

```json
{
  "token": "uuid-v4-string",
  "expiresAt": 1707523200000,
  "userName": "John"
}
```

**Error responses:** `400` (missing initData), `401` (invalid hash, expired, unauthorized user)

---

### Health

#### `GET /healthz`

No authentication required.

**Response (200):**

```json
{ "ok": true, "service": "dashboard", "authRequired": true }
```

---

### Live Logs

#### `GET /api/logs/stream`

Server-Sent Events (SSE) endpoint for real-time log streaming.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `afterId` | No | Only send logs with IDs greater than this value. If `0` or omitted, sends the full ring buffer as catch-up. |

**SSE event format:**

```
event: log
data: {"id":123,"level":30,"time":1707523200000,"msg":"...","module":"...","group_folder":"..."}
```

Heartbeat comments (`: heartbeat`) are sent every 15 seconds to keep the connection alive.

#### `GET /api/logs`

Query persisted logs from SQLite with filtering and pagination.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `level` | integer | Filter by Pino log level (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal) |
| `search` | string | Substring match on the log message |
| `group` | string | Filter by group folder name |
| `since` | integer | Unix timestamp (ms) -- only logs at or after this time |
| `until` | integer | Unix timestamp (ms) -- only logs at or before this time |
| `limit` | integer | Max rows to return |
| `offset` | integer | Pagination offset |

#### `GET /api/logs/stats`

Aggregate log statistics: total count, count by level, oldest/newest timestamps.

#### `GET /api/logs/:id`

Retrieve a single log entry with extra context fields parsed from the raw JSON.

---

### Container Logs

#### `GET /api/containers`

List container execution log entries.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `group` | string | Filter by group folder name |
| `since` | string | ISO 8601 timestamp -- only entries at or after this time |
| `limit` | integer | Max rows to return |

#### `GET /api/containers/:group/:filename`

Retrieve the raw text content of a specific container log file. The file is read from `groups/<group>/logs/<filename>`.

---

### Task Monitoring

#### `GET /api/tasks`

List all scheduled tasks, each enriched with its 5 most recent execution runs.

**Query parameters:**

| Parameter | Description |
|---|---|
| `group` | Filter tasks by group folder name |

#### `GET /api/tasks/runs`

List task execution history across all tasks.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max rows to return |
| `offset` | integer | `0` | Pagination offset |

---

### File Management (Agent Groups)

These endpoints manage files within the `groups/` directory on the host filesystem.

#### `GET /api/files/groups`

List all group directories with their total file size.

#### `GET /api/files/agent/list`

Browse the file tree within a group directory.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `group` | `"main"` | Group folder name |
| `path` | `"."` | Relative path within the group directory |

#### `GET /api/files/agent/download`

Download a file from a group directory. Returns the file with appropriate `Content-Type` and `Content-Disposition: attachment` headers.

#### `POST /api/files/agent/upload`

Upload a file to a group directory. Uses `multipart/form-data`.

**Form fields:** `group` (default: `"main"`), `path` (default: `"."`), `file` (required, max 50 MB)

#### `POST /api/files/agent/mkdir`

Create a directory within a group.

**Request body:** `{ "group": "main", "path": "media/screenshots" }`

#### `POST /api/files/agent/rename`

Rename or move a file/directory within a group.

**Request body:** `{ "group": "main", "oldPath": "old.txt", "newPath": "new.txt" }`

#### `DELETE /api/files/agent/delete`

Delete a file or directory (recursive). Protected files (`CLAUDE.md`, `SOUL.md`) return `403`.

**Request body:** `{ "group": "main", "path": "unwanted.png" }`

#### `GET /api/files/agent/info`

Get file metadata with optional inline preview. Text files up to 10 KB return content as `preview`. Image files up to 2 MB return base64 `preview`.

#### `GET /api/files/agent/search`

Search for files by name within a group directory tree. Case-insensitive substring match, max 50 results, max depth 5.

**Query parameters:** `group`, `q` (required search query)

---

### File Management (CUA Sandbox)

These endpoints manage files inside the CUA browser sandbox Docker container. File operations are executed via the CUA `/cmd` API using shell commands.

#### `GET /api/files/cua/status`

Check whether the CUA sandbox container is currently running.

#### `POST /api/files/cua/start`

Start the CUA sandbox on demand if it is not already running.

#### `GET /api/files/cua/list`

Browse files in the CUA sandbox. Default path: `/root`.

#### `GET /api/files/cua/download`

Download a file from the CUA sandbox (read via base64 encoding over the command API).

#### `POST /api/files/cua/upload`

Upload a file into the CUA sandbox. Default destination: `/root/Downloads`. Large files are chunked at 64 KB.

#### `POST /api/files/cua/mkdir` / `POST /api/files/cua/rename` / `DELETE /api/files/cua/delete`

Create, rename, or delete files/directories in the sandbox.

#### `GET /api/files/cua/search`

Search for files by name in the sandbox (uses `find` with `-iname`). Max 50 results, max depth 5.

---

### File Transfer

#### `POST /api/files/transfer`

Transfer files between agent group storage and the CUA sandbox.

**Request body:**

```json
{
  "direction": "cua-to-agent",
  "sourcePath": "/root/Downloads/screenshot.png",
  "destPath": "media",
  "group": "main"
}
```

| Field | Required | Description |
|---|---|---|
| `direction` | Yes | `"cua-to-agent"` or `"agent-to-cua"` |
| `sourcePath` | Yes | Source file path |
| `destPath` | No | Destination path (defaults vary by direction) |
| `group` | No | Agent group folder (default: `"main"`) |

For `cua-to-agent` transfers, the filename is appended with a timestamp to avoid collisions.

---

### CUA Follow (Live Activity Monitoring)

The Follow page provides real-time visibility into CUA browser automation activity. It combines a live noVNC desktop view with an activity feed showing agent actions.

**Access:** Via the `/follow` Telegram command, which opens a scoped Mini App session.

#### `GET /cua/follow`

Serves the Follow page HTML (single-page app with embedded noVNC viewer and activity feed).

#### `GET /api/cua/follow/stream`

SSE endpoint for real-time CUA activity events (clicks, navigations, screenshots, etc.). Events include timestamps, action types, and parameter summaries.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `group` | No | Group folder to filter events (auto-set from session scope) |

#### `GET /api/cua/follow/vnc-info`

Returns VNC connection info for the embedded noVNC viewer.

#### `POST /api/cua/follow/message`

Send a message to the agent from the Follow page (rate-limited to 10 messages per minute).

**Notes:**
- Follow sessions are scoped to the group associated with the Telegram chat where `/follow` was invoked
- A summary of CUA activity is periodically sent to the Telegram chat while a Follow session is active
- Activity events are buffered in a ring buffer for catch-up on reconnect

---

## Telegram Integration

### Menu Button

On bot startup, the host process calls Telegram's `setChatMenuButton` API to register a WebApp button labeled "Dashboard" that opens `<dashboard-url>/app` as a Telegram Mini App.

### `/dashboard` Command

The bot registers a `/dashboard` command that replies with an inline keyboard containing a WebApp button. If `DASHBOARD_ENABLED` is `false`, it replies indicating the dashboard is disabled.

### Tailscale Serve (HTTPS)

Telegram Mini Apps require HTTPS. When `SANDBOX_TAILSCALE_ENABLED=true` (default), the host configures Tailscale serve at startup:

```
tailscale serve --bg --https=<DASHBOARD_HTTPS_PORT> http://localhost:<DASHBOARD_PORT>
```

This produces a URL like `https://<hostname>.ts.net:<DASHBOARD_HTTPS_PORT>`. The Tailscale FQDN is auto-detected and cached. On shutdown, the serve mapping is cleaned up.

## Source Files

| File | Purpose |
|---|---|
| `src/dashboard-server.ts` | Dashboard HTTP server, API routes, and embedded SPA |
| `src/dashboard-auth.ts` | Telegram initData HMAC validation and session management |
| `src/tailscale-serve.ts` | Tailscale reverse proxy setup/teardown for HTTPS |
| `src/config.ts` | Dashboard configuration constants and env var parsing |
| `src/db.ts` | SQLite query functions used by log, container, and task APIs |
| `src/log-sync.ts` | Ring buffer and event emitter for real-time log streaming |
