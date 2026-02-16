/**
 * PromptBuilder service — prepares the final prompt with SOUL.md injection.
 */

import { Context, Effect, Layer } from 'effect';
import fs from 'fs';
import type { ContainerInput } from '../schemas/ContainerIO.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface PromptBuilderService {
  /** Prepare the final prompt with SOUL.md, task/skill markers */
  readonly prepare: (input: ContainerInput) => Effect.Effect<string>;
}

export class PromptBuilder extends Context.Tag('PromptBuilder')<
  PromptBuilder,
  PromptBuilderService
>() {}

// ─── Live Layer ────────────────────────────────────────────────────────────

export const PromptBuilderLive: Layer.Layer<PromptBuilder> = Layer.succeed(
  PromptBuilder,
  {
    prepare: (input) =>
      Effect.gen(function* () {
        let prompt = input.prompt;

        // Read SOUL.md personality
        const soulContent = yield* Effect.try(() =>
          fs.readFileSync('/workspace/group/SOUL.md', 'utf-8').trim(),
        ).pipe(Effect.orElseSucceed(() => ''));

        if (soulContent) {
          prompt = `<soul>\n${soulContent}\n</soul>\n\n${prompt}`;
        }

        if (input.isScheduledTask) {
          prompt = `[SCHEDULED TASK - Running automatically per schedule. Complete the task and report results via send_message.]\n\n${prompt}`;
        }

        if (input.isSkillInvocation) {
          prompt = `[SKILL INVOCATION - Follow the skill instructions below precisely.]\n\n${prompt}`;
        }

        return prompt;
      }),
  },
);
