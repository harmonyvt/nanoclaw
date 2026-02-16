/**
 * Filesystem tools: read_file, write_file (with workspace path validation).
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';

export const filesystemTools: NanoTool[] = [
  {
    name: 'read_file',
    description:
      'Read a file from the group workspace (/workspace/group/) or global workspace (/workspace/global/). Returns the file content as text.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to the file to read (must be under /workspace/group/ or /workspace/global/)',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        // yield* HostBridge not needed but required by type signature
        yield* Effect.succeed(undefined);

        const rawPath = args.path as string;
        const resolvedPath = path.resolve(rawPath);

        if (
          !resolvedPath.startsWith('/workspace/group/') &&
          !resolvedPath.startsWith('/workspace/global/')
        ) {
          return {
            content: 'Access denied: path must be under /workspace/group/ or /workspace/global/',
            isError: true as const,
          };
        }

        if (!fs.existsSync(resolvedPath)) {
          return { content: `File not found: ${resolvedPath}`, isError: true as const };
        }

        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) {
          return { content: `Path is a directory, not a file: ${resolvedPath}`, isError: true as const };
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const MAX_SIZE = 100_000;
        if (content.length > MAX_SIZE) {
          return {
            content: content.slice(0, MAX_SIZE) + `\n\n[Truncated at ${MAX_SIZE} characters]`,
          };
        }
        return { content };
      }),
  },

  {
    name: 'write_file',
    description:
      'Write content to a file in the group workspace (/workspace/group/). Creates parent directories automatically. Use this to create or update SOUL.md, voice_profile.json, and other group files.',
    schema: z.object({
      path: z
        .string()
        .describe('Absolute path to write the file (must be under /workspace/group/)'),
      content: z.string().describe('The content to write to the file'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        yield* Effect.succeed(undefined);

        const rawPath = args.path as string;
        const fileContent = args.content as string;
        const resolvedPath = path.resolve(rawPath);

        if (!resolvedPath.startsWith('/workspace/group/')) {
          return {
            content: 'Access denied: can only write to /workspace/group/',
            isError: true as const,
          };
        }

        try {
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

          const tempPath = `${resolvedPath}.tmp`;
          fs.writeFileSync(tempPath, fileContent);
          fs.renameSync(tempPath, resolvedPath);

          return {
            content: `File written: ${resolvedPath} (${Buffer.byteLength(fileContent)} bytes)`,
          };
        } catch (err) {
          return {
            content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
            isError: true as const,
          };
        }
      }),
  },
];
