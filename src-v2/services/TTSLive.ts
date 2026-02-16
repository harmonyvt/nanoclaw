/**
 * TTSLive — text-to-speech dispatch across Qwen/Replicate providers.
 *
 * Port of src/tts-dispatch.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import { TTSError } from '../errors.js';
import { TTS } from './TTS.js';
import type { TTSService, TTSResult, VoiceProfile } from './TTS.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Skip TTS for code-heavy responses. */
export function looksLikeCode(text: string): boolean {
  const codeIndicators = ['```', '{"', 'function ', 'const ', 'import ', '=> {'];
  const codeRatio = codeIndicators.reduce(
    (count, indicator) => count + (text.includes(indicator) ? 1 : 0),
    0,
  );
  return codeRatio >= 2 || (text.match(/```/g)?.length ?? 0) >= 2;
}

function loadVoiceProfileFromDisk(
  groupsDir: string,
  groupFolder: string,
): VoiceProfile | null {
  const profilePath = path.join(groupsDir, groupFolder, 'voice_profile.json');
  if (!fs.existsSync(profilePath)) return null;
  try {
    const raw = fs.readFileSync(profilePath, 'utf-8');
    return JSON.parse(raw) as VoiceProfile;
  } catch {
    return null;
  }
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const TTSLive: Layer.Layer<TTS, never, AppConfig> = Layer.effect(
  TTS,
  Effect.gen(function* () {
    const config = yield* AppConfig;

    const qwenEnabled = config.qwenTtsEnabled;
    const replicateEnabled = config.replicateTtsEnabled;

    const service: TTSService = {
      synthesize: ({ text, groupFolder, voiceProfile, emotion }) =>
        Effect.gen(function* () {
          if (looksLikeCode(text)) {
            return yield* Effect.fail(
              new TTSError({
                message: 'Skipped: code content',
                provider: 'none',
              }),
            );
          }

          // Load voice profile from disk if not provided
          const profile =
            voiceProfile ||
            loadVoiceProfileFromDisk(config.groupsDir, groupFolder);

          const provider = profile?.provider || config.replicateTtsDefaultProvider;
          const isSelfHosted = provider === 'qwen3-tts';

          // Self-hosted Qwen
          if (isSelfHosted && qwenEnabled && config.qwenTtsUrl) {
            return yield* synthesizeQwen(config, text, groupFolder, profile, emotion);
          }

          // Replicate-hosted
          if (replicateEnabled && config.replicateApiToken) {
            return yield* synthesizeReplicate(config, text, groupFolder, profile, emotion);
          }

          return yield* Effect.fail(
            new TTSError({
              message: 'No TTS provider enabled',
              provider: 'none',
            }),
          );
        }),

      isEnabled: Effect.succeed(qwenEnabled || replicateEnabled),
    };

    return service;
  }),
);

// ─── Provider Implementations ───────────────────────────────────────────────

function synthesizeQwen(
  config: {
    qwenTtsUrl: string;
    qwenTtsApiKey: string;
    qwenTtsDefaultLanguage: string;
    qwenTtsDefaultSpeaker: string;
    groupsDir: string;
  },
  text: string,
  groupFolder: string,
  profile: VoiceProfile | null,
  emotion?: string,
): Effect.Effect<TTSResult, TTSError> {
  return Effect.tryPromise({
    try: async () => {
      const startMs = Date.now();
      const speaker = profile?.speaker || config.qwenTtsDefaultSpeaker;
      const language = profile?.language || config.qwenTtsDefaultLanguage;

      const body: Record<string, unknown> = {
        text,
        speaker,
        language,
      };
      if (emotion) body.emotion = emotion;
      if (profile?.referenceAudio) body.ref_audio_path = profile.referenceAudio;
      if (profile?.referenceText) body.ref_text = profile.referenceText;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.qwenTtsApiKey) {
        headers['Authorization'] = `Bearer ${config.qwenTtsApiKey}`;
      }

      const response = await fetch(`${config.qwenTtsUrl}/synthesize`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`TTS HTTP ${response.status}: ${await response.text()}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const mediaDir = path.join(config.groupsDir, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filename = `tts-${Date.now()}.ogg`;
      const audioPath = path.join(mediaDir, filename);
      fs.writeFileSync(audioPath, audioBuffer);

      return {
        audioPath,
        provider: 'qwen3-tts',
        durationMs: Date.now() - startMs,
      } satisfies TTSResult;
    },
    catch: (err) =>
      new TTSError({
        message: `Qwen TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        provider: 'qwen3-tts',
        cause: err,
      }),
  });
}

function synthesizeReplicate(
  config: {
    replicateApiToken: string;
    replicateTtsDefaultProvider: string;
    replicateTtsDefaultSpeaker: string;
    replicateTtsTimeoutMs: number;
    groupsDir: string;
  },
  text: string,
  groupFolder: string,
  profile: VoiceProfile | null,
  _emotion?: string,
): Effect.Effect<TTSResult, TTSError> {
  return Effect.tryPromise({
    try: async () => {
      const startMs = Date.now();
      const provider = profile?.provider || config.replicateTtsDefaultProvider;
      const speaker = profile?.speaker || config.replicateTtsDefaultSpeaker;

      const Replicate = (await import('replicate')).default;
      const replicate = new Replicate({ auth: config.replicateApiToken });

      const input: Record<string, unknown> = {
        text,
        speaker,
      };
      if (profile?.referenceAudio) input.ref_audio = profile.referenceAudio;
      if (profile?.referenceText) input.ref_text = profile.referenceText;

      const output = (await replicate.run(provider as `${string}/${string}`, {
        input,
      })) as string | { url?: string; output?: string };

      // Extract audio URL from output
      let audioUrl: string;
      if (typeof output === 'string') {
        audioUrl = output;
      } else if (output?.url) {
        audioUrl = output.url;
      } else if (output?.output) {
        audioUrl = String(output.output);
      } else {
        throw new Error('No audio URL in Replicate response');
      }

      // Download audio
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        throw new Error(`Audio download failed: HTTP ${audioRes.status}`);
      }

      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
      const mediaDir = path.join(config.groupsDir, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filename = `tts-${Date.now()}.ogg`;
      const audioPath = path.join(mediaDir, filename);
      fs.writeFileSync(audioPath, audioBuffer);

      return {
        audioPath,
        provider,
        durationMs: Date.now() - startMs,
      } satisfies TTSResult;
    },
    catch: (err) =>
      new TTSError({
        message: `Replicate TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        provider: config.replicateTtsDefaultProvider,
        cause: err,
      }),
  });
}
