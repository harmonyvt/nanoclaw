/**
 * Composio integration for NanoClaw.
 * Uses the @composio/client REST API to provide access to 500+ third-party
 * tool integrations (Google Calendar, Sheets, Slack, GitHub, etc.).
 *
 * The agent dynamically discovers, inspects, and executes Composio tools
 * at runtime — no hard-coded integrations needed.
 */

import { Composio } from '@composio/client';

let _client: Composio | null = null;

export function getComposioClient(): Composio | null {
  if (_client) return _client;

  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return null;

  _client = new Composio({ apiKey });
  return _client;
}

/** User ID scoping — Composio scopes connected accounts per user_id. */
export function getComposioUserId(groupFolder: string): string {
  return `nanoclaw_${groupFolder}`;
}
