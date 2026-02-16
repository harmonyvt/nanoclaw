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
        const soulPath = '/workspace/group/SOUL.md';
        const voiceProfilePath = '/workspace/group/voice_profile.json';

        const soulContent = yield* Effect.try(() =>
          fs.readFileSync(soulPath, 'utf-8').trim(),
        ).pipe(Effect.orElseSucceed(() => ''));

        if (soulContent) {
          prompt = `<soul>\n${soulContent}\n</soul>\n\n${prompt}`;

          // Auto-generate voice profile if SOUL exists but voice_profile.json doesn't
          const hasVoiceProfile = yield* Effect.try(() =>
            fs.existsSync(voiceProfilePath),
          ).pipe(Effect.orElseSucceed(() => true));

          if (!hasVoiceProfile && !input.isScheduledTask) {
            prompt += '\n<voice_setup>\nYou have a personality but no voice profile yet. Based on your SOUL.md personality, create /workspace/group/voice_profile.json with a voice that matches this personality. Use voice_design mode with a natural language description of how this personality should sound (age, gender, tone, accent, speaking style).\n\nFormat: {"provider":"qwen3-tts","mode":"voice_design","voice_design":{"description":"<describe the voice>","language":"English"},"created_at":"<ISO timestamp>","updated_at":"<ISO timestamp>"}\n\nDo this silently before responding to the user.\n</voice_setup>\n';
          }
        }

        if (input.isScheduledTask) {
          prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${prompt}`;
        }

        if (input.isSkillInvocation) {
          prompt = `[SKILL INVOCATION - You are executing a stored skill. Follow the instructions in the <skill> block precisely. Report progress and results using send_message.]\n\n${prompt}`;
        }

        return prompt;
      }),
  },
);
