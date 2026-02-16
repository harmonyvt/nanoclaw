/**
 * GroupRegistry — shared mutable state for registered groups.
 * Uses SynchronizedRef for atomic effectful updates.
 */

import { Context, Effect } from 'effect';
import type { RegisteredGroup } from '../schemas/Groups.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface GroupRegistryService {
  /** Get all registered groups */
  readonly getAll: Effect.Effect<Record<string, RegisteredGroup>>;

  /** Get a specific group by chat JID */
  readonly get: (
    chatJid: string,
  ) => Effect.Effect<RegisteredGroup | undefined>;

  /** Register or update a group */
  readonly register: (
    chatJid: string,
    group: RegisteredGroup,
  ) => Effect.Effect<void>;

  /** Load state from disk */
  readonly loadState: Effect.Effect<void>;

  /** Save state to disk */
  readonly saveState: Effect.Effect<void>;

  /** Resolve group folder from chat JID */
  readonly folderForChatJid: (
    chatJid: string,
  ) => Effect.Effect<string | undefined>;

  /** Resolve chat JID from group folder */
  readonly chatJidForFolder: (
    folder: string,
  ) => Effect.Effect<string | undefined>;
}

export class GroupRegistry extends Context.Tag('GroupRegistry')<
  GroupRegistry,
  GroupRegistryService
>() {}
