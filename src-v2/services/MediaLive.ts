/**
 * MediaLive — audio transcription, file download, media cleanup.
 *
 * Port of src/media.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import { MediaError, TranscriptionError } from '../errors.js';
import { Media } from './Media.js';
import type { MediaService } from './Media.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const AUDIO_MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const MediaLive: Layer.Layer<Media, never, AppConfig> = Layer.effect(
  Media,
  Effect.gen(function* () {
    const config = yield* AppConfig;

    const service: MediaService = {
      transcribeAudio: (audioPath) =>
        Effect.gen(function* () {
          if (!config.replicateApiToken) {
            return yield* Effect.fail(
              new TranscriptionError({
                message: 'REPLICATE_API_TOKEN not set, cannot transcribe',
              }),
            );
          }

          return yield* Effect.tryPromise({
            try: async () => {
              const fileBuffer = fs.readFileSync(audioPath);
              const ext = path.extname(audioPath).toLowerCase();
              const mime = AUDIO_MIME[ext] || 'audio/wav';
              const base64 = fileBuffer.toString('base64');
              const dataUri = `data:${mime};base64,${base64}`;

              const Replicate = (await import('replicate')).default;
              const replicate = new Replicate({
                auth: config.replicateApiToken,
              });
              const output = (await replicate.run(
                'openai/gpt-4o-transcribe' as `${string}/${string}`,
                { input: { audio: dataUri } },
              )) as { text?: string };

              return output?.text ?? '';
            },
            catch: (err) =>
              new TranscriptionError({
                message: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              }),
          });
        }),

      downloadFile: (fileId, destDir, filename) =>
        Effect.tryPromise({
          try: async () => {
            const botToken = config.telegramBotToken;
            const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
            const fileInfoRes = await fetch(fileInfoUrl);
            if (!fileInfoRes.ok)
              throw new Error(`getFile failed: HTTP ${fileInfoRes.status}`);
            const fileInfo = (await fileInfoRes.json()) as {
              ok: boolean;
              result?: { file_path?: string; file_size?: number };
            };
            if (!fileInfo.ok || !fileInfo.result?.file_path) {
              throw new Error('No file_path in Telegram response');
            }

            if (
              fileInfo.result.file_size &&
              fileInfo.result.file_size > MAX_TELEGRAM_FILE_SIZE
            ) {
              throw new Error(
                `File too large: ${fileInfo.result.file_size} bytes`,
              );
            }

            const remotePath = fileInfo.result.file_path;
            const ext = path.extname(remotePath) || '';
            const localName = filename || `${fileId}${ext}`;
            const localPath = path.join(destDir, localName);

            fs.mkdirSync(destDir, { recursive: true });

            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
            const response = await fetch(downloadUrl);
            if (!response.ok)
              throw new Error(`Download failed: HTTP ${response.status}`);

            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(localPath, buffer);

            return localPath;
          },
          catch: (err) =>
            new MediaError({
              message: `File download failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        }),

      cleanupOldMedia: (mediaDir, retentionDays) =>
        Effect.try({
          try: () => {
            if (!fs.existsSync(mediaDir)) return 0;

            const cutoff =
              Date.now() - retentionDays * 24 * 60 * 60 * 1000;
            let cleaned = 0;

            for (const file of fs.readdirSync(mediaDir)) {
              // Preserve voice clone reference audio
              if (file.startsWith('voice_ref')) continue;
              const filePath = path.join(mediaDir, file);
              try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && stat.mtimeMs < cutoff) {
                  fs.unlinkSync(filePath);
                  cleaned++;
                }
              } catch {
                // best effort
              }
            }

            return cleaned;
          },
          catch: () => 0 as number,
        }).pipe(Effect.orElseSucceed(() => 0)),
    };

    return service;
  }),
);
