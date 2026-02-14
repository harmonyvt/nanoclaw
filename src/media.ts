import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';
import Replicate from 'replicate';

import { logger } from './logger.js';
import { REPLICATE_API_TOKEN } from './config.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram limit

/**
 * Download a file from Telegram to a local directory.
 * Returns the local file path.
 */
export async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  destDir: string,
): Promise<string | null> {
  const file = await bot.api.getFile(fileId);

  // Check file size before downloading
  if (file.file_size && file.file_size > MAX_FILE_SIZE) {
    logger.warn(
      { fileId, size: file.file_size, maxSize: MAX_FILE_SIZE },
      'File too large to download, skipping',
    );
    return null;
  }

  const filePath = file.file_path;
  if (!filePath) {
    logger.warn({ fileId }, 'No file_path returned from Telegram');
    return null;
  }

  // Derive extension from the remote path
  const ext = path.extname(filePath) || '';
  const localName = `${fileId}${ext}`;
  const localPath = path.join(destDir, localName);

  fs.mkdirSync(destDir, { recursive: true });

  // Build download URL and fetch
  const url = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    logger.error(
      { fileId, status: response.status },
      'Failed to download Telegram file',
    );
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  logger.debug({ fileId, localPath, size: buffer.length }, 'File downloaded');
  return localPath;
}

/**
 * MIME type lookup for common audio extensions.
 */
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

/**
 * Transcribe an audio file using Replicate GPT-4o-transcribe.
 * Returns the transcription text.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!REPLICATE_API_TOKEN) {
    logger.warn('REPLICATE_API_TOKEN not set, cannot transcribe audio');
    return '[transcription unavailable]';
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = AUDIO_MIME[ext] || 'audio/wav';
    const base64 = fileBuffer.toString('base64');
    const dataUri = `data:${mime};base64,${base64}`;

    const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });
    const output = (await replicate.run('openai/gpt-4o-transcribe', {
      input: { audio: dataUri },
    })) as { text: string };

    const text = output?.text ?? '';
    logger.debug({ filePath, length: text.length }, 'Audio transcribed');
    return text;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Replicate transcription failed',
    );
    return '[transcription failed]';
  }
}

/**
 * Delete media files older than maxAgeDays in the given directory.
 */
export function cleanupOldMedia(mediaDir: string, maxAgeDays: number): void {
  if (!fs.existsSync(mediaDir)) return;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
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
    } catch (err) {
      logger.debug({ filePath, err }, 'Error cleaning up media file');
    }
  }

  if (cleaned > 0) {
    logger.info({ mediaDir, cleaned }, 'Old media files cleaned up');
  }
}
