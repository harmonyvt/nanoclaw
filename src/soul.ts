import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';

/**
 * Parse assistant name from SOUL.md content.
 * Uses the first markdown H1 line, e.g. "# Yoona".
 */
export function parseSoulName(soulContent: string): string | undefined {
  const match = soulContent.match(/^\s*#\s+(.+?)\s*$/m);
  if (!match) return undefined;
  const name = match[1].trim().replace(/\s+#*$/, '');
  return name || undefined;
}

/**
 * Resolve assistant identity for a group.
 * Falls back to ASSISTANT_NAME when SOUL.md is missing or invalid.
 */
export function resolveAssistantIdentity(
  groupFolder: string,
  fallback = ASSISTANT_NAME,
): string {
  const soulPath = path.join(GROUPS_DIR, groupFolder, 'SOUL.md');
  try {
    if (!fs.existsSync(soulPath)) return fallback;
    const soul = fs.readFileSync(soulPath, 'utf-8');
    return parseSoulName(soul) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * True when SOUL.md exists and contains non-empty content.
 */
export function hasSoulConfigured(groupFolder: string): boolean {
  const soulPath = path.join(GROUPS_DIR, groupFolder, 'SOUL.md');
  try {
    if (!fs.existsSync(soulPath)) return false;
    const soul = fs.readFileSync(soulPath, 'utf-8').trim();
    return soul.length > 0;
  } catch {
    return false;
  }
}
