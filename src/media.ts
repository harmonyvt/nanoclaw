import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';

import { logger } from './logger.js';

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
 * Transcribe an audio file using OpenAI Whisper API.
 * Returns the transcription text.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, cannot transcribe audio');
    return '[transcription unavailable]';
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('model', 'whisper-1');
  formData.append('file', new Blob([fileBuffer]), fileName);

  const response = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      'Whisper transcription failed',
    );
    return '[transcription failed]';
  }

  const result = (await response.json()) as { text: string };
  logger.debug({ filePath, length: result.text.length }, 'Audio transcribed');
  return result.text;
}

/**
 * Delete media files older than maxAgeDays in the given directory.
 */
export function cleanupOldMedia(mediaDir: string, maxAgeDays: number): void {
  if (!fs.existsSync(mediaDir)) return;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const file of fs.readdirSync(mediaDir)) {
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
