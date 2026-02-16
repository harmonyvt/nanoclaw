/**
 * GroupRegistryLive — SynchronizedRef + JSON file persistence.
 *
 * Groups are loaded from data/registered_groups.json (NOT database).
 * Port of the global registeredGroups Map from src/index.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { Effect, Layer, SynchronizedRef } from 'effect';

import { AppConfig } from '../config.js';
import { GroupRegistry } from './GroupRegistry.js';
import type { GroupRegistryService } from './GroupRegistry.js';
import type { RegisteredGroup } from '../schemas/Groups.js';

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const GroupRegistryLive: Layer.Layer<GroupRegistry, never, AppConfig> =
  Layer.effect(
    GroupRegistry,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const filePath = path.join(config.dataDir, 'registered_groups.json');

      // Load initial state from JSON file
      const initial: Record<string, RegisteredGroup> = yield* Effect.try({
        try: (): Record<string, RegisteredGroup> => {
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(raw) as Record<string, RegisteredGroup>;
          }
          return {};
        },
        catch: () => new Error('Failed to load groups'),
      }).pipe(Effect.orElseSucceed((): Record<string, RegisteredGroup> => ({})));

      const ref = yield* SynchronizedRef.make(initial);

      const persist = SynchronizedRef.get(ref).pipe(
        Effect.flatMap((groups) =>
          Effect.try({
            try: () => {
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, JSON.stringify(groups, null, 2));
            },
            catch: (err) => new Error(`Failed to persist groups: ${err}`),
          }),
        ),
        Effect.ignore,
      );

      const service: GroupRegistryService = {
        getAll: SynchronizedRef.get(ref),

        get: (chatJid) =>
          SynchronizedRef.get(ref).pipe(
            Effect.map((groups) => groups[chatJid]),
          ),

        register: (chatJid, group) =>
          SynchronizedRef.update(ref, (groups) => ({
            ...groups,
            [chatJid]: group,
          })).pipe(Effect.tap(() => persist)),

        loadState: Effect.gen(function* () {
          if (!fs.existsSync(filePath)) return;
          const raw = yield* Effect.try({
            try: () => fs.readFileSync(filePath, 'utf-8'),
            catch: () => new Error('Failed to read groups file'),
          }).pipe(Effect.orElseSucceed(() => '{}'));
          const groups = yield* Effect.try({
            try: () =>
              JSON.parse(raw) as Record<string, RegisteredGroup>,
            catch: () => new Error('Failed to parse groups JSON'),
          }).pipe(Effect.orElseSucceed((): Record<string, RegisteredGroup> => ({})));
          yield* SynchronizedRef.set(ref, groups);
        }),

        saveState: persist,

        folderForChatJid: (chatJid) =>
          SynchronizedRef.get(ref).pipe(
            Effect.map((groups) => groups[chatJid]?.folder),
          ),

        chatJidForFolder: (folder) =>
          SynchronizedRef.get(ref).pipe(
            Effect.map((groups) => {
              for (const [jid, group] of Object.entries(groups)) {
                if (group.folder === folder) return jid;
              }
              return undefined;
            }),
          ),
      };

      return service;
    }),
  );
