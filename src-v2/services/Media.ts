/**
 * Media service — audio transcription, file download, media cleanup.
 */

import { Context, Effect } from 'effect';
import type { MediaError, TranscriptionError } from '../errors.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface MediaService {
  /** Transcribe an audio file to text */
  readonly transcribeAudio: (
    audioPath: string,
  ) => Effect.Effect<string, TranscriptionError>;

  /** Download a file from Telegram API */
  readonly downloadFile: (
    fileId: string,
    destDir: string,
    filename?: string,
  ) => Effect.Effect<string, MediaError>;

  /** Clean up old media files in a directory */
  readonly cleanupOldMedia: (
    mediaDir: string,
    retentionDays: number,
  ) => Effect.Effect<number>;
}

export class Media extends Context.Tag('Media')<Media, MediaService>() {}
