/**
 * Skills tools: store_skill, list_skills, delete_skill.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import type { HostBridge } from '../services/HostBridge.js';
import type { ToolError } from '../errors/index.js';
import { requestHost, writeIpcFile, TASKS_DIR } from './utils.js';

const RESERVED = new Set([
  'tasks', 'runtask', 'new', 'clear', 'status', 'update', 'rebuild',
  'takeover', 'dashboard', 'follow', 'verbose', 'stop', 'help', 'skills',
  'start', 'settings', 'cancel', 'menu', 'debug',
]);

/** Try RPC first, fall back to file IPC for task-like dispatch. */
function dispatchTaskAction(
  data: Record<string, unknown>,
): Effect.Effect<string | null, ToolError, HostBridge> {
  return Effect.gen(function* () {
    const viaRpc = yield* requestHost('tasks.handle', data);
    if (viaRpc) {
      const rpc = viaRpc as { ok?: boolean; message?: string };
      return rpc.message || 'Task action handled.';
    }
    return writeIpcFile(TASKS_DIR, data);
  });
}

export const skillTools: NanoTool[] = [
  {
    name: 'store_skill',
    description: `Save a reusable skill (workflow) that becomes a Telegram /command. When invoked, the skill instructions guide the agent through the workflow automatically.

Write clear, step-by-step instructions that a fresh agent session can follow. For browser automation skills, include specific URLs, element descriptions, expected page states, and error recovery steps. You can use memory_search first to enrich the instructions with details from past workflows.

If a skill with the same name already exists, it will be overwritten.`,
    schema: z.object({
      name: z
        .string()
        .describe(
          'Skill name (lowercase, letters/numbers/underscores, 2-32 chars). Becomes the Telegram /command.',
        ),
      description: z
        .string()
        .describe(
          'Short description shown in Telegram command menu (max 100 chars)',
        ),
      instructions: z
        .string()
        .describe(
          'Detailed step-by-step instructions for the agent when this skill is invoked. Be specific.',
        ),
      parameters: z
        .string()
        .optional()
        .describe(
          'Optional: describe what parameters the user can pass after the command (e.g., "time period like \'last_week\' or \'today\'")',
        ),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const name = args.name as string;
        const description = args.description as string;
        const instructions = args.instructions as string;
        const parameters = args.parameters as string | undefined;

        if (!/^[a-z][a-z0-9_]{1,30}$/.test(name)) {
          return {
            content:
              'Invalid skill name. Must be 2-32 chars, lowercase, start with a letter, only letters/numbers/underscores.',
            isError: true as const,
          };
        }

        if (RESERVED.has(name)) {
          return {
            content: `"${name}" is a reserved command name. Choose a different name.`,
            isError: true as const,
          };
        }

        const desc = description.slice(0, 100);
        const now = new Date().toISOString();
        const skillData = {
          name,
          description: desc,
          instructions,
          ...(parameters ? { parameters } : {}),
          created_at: now,
          updated_at: now,
        };

        const skillsDir = '/workspace/group/skills';
        fs.mkdirSync(skillsDir, { recursive: true });
        const skillPath = path.join(skillsDir, `${name}.json`);

        // Preserve created_at if updating
        try {
          if (fs.existsSync(skillPath)) {
            const existing = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
            if (existing.created_at) {
              skillData.created_at = existing.created_at;
            }
          }
        } catch { /* ignore */ }

        const tempPath = `${skillPath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(skillData, null, 2));
        fs.renameSync(tempPath, skillPath);

        yield* dispatchTaskAction({
          type: 'skill_changed',
          action: 'stored',
          skillName: name,
          groupFolder: ctx.groupFolder,
          timestamp: now,
        });

        return {
          content: `Skill "/${name}" saved. It will appear as a Telegram command shortly.`,
        };
      }),
  },

  {
    name: 'list_skills',
    description:
      'List all stored skills (reusable workflows) for the current group. Shows name, description, and parameter info.',
    schema: z.object({}),
    handler: () =>
      Effect.gen(function* () {
        yield* Effect.succeed(undefined);

        const skillsDir = '/workspace/group/skills';

        try {
          if (!fs.existsSync(skillsDir)) {
            return { content: 'No skills stored yet.' };
          }

          const files = fs
            .readdirSync(skillsDir)
            .filter((f) => f.endsWith('.json'));

          if (files.length === 0) {
            return { content: 'No skills stored yet.' };
          }

          const skills = files
            .map((f) => {
              try {
                return JSON.parse(
                  fs.readFileSync(path.join(skillsDir, f), 'utf-8'),
                ) as { name: string; description: string; parameters?: string };
              } catch {
                return null;
              }
            })
            .filter(Boolean) as Array<{ name: string; description: string; parameters?: string }>;

          if (skills.length === 0) {
            return { content: 'No valid skills found.' };
          }

          const formatted = skills
            .map((s) => {
              let line = `- /${s.name}: ${s.description}`;
              if (s.parameters) line += ` (params: ${s.parameters})`;
              return line;
            })
            .join('\n');

          return { content: `Stored skills:\n${formatted}` };
        } catch (err) {
          return {
            content: `Error listing skills: ${err instanceof Error ? err.message : String(err)}`,
            isError: true as const,
          };
        }
      }),
  },

  {
    name: 'delete_skill',
    description: 'Delete a stored skill. Removes it from Telegram commands.',
    schema: z.object({
      name: z.string().describe('The skill name to delete'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const name = args.name as string;

        if (!/^[a-z][a-z0-9_]{1,30}$/.test(name)) {
          return { content: 'Invalid skill name.', isError: true as const };
        }

        const skillPath = `/workspace/group/skills/${name}.json`;

        if (!fs.existsSync(skillPath)) {
          return { content: `Skill "${name}" not found.`, isError: true as const };
        }

        fs.unlinkSync(skillPath);

        yield* dispatchTaskAction({
          type: 'skill_changed',
          action: 'deleted',
          skillName: name,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        });

        return { content: `Skill "/${name}" deleted.` };
      }),
  },
];
