/**
 * Audio tools: download_audio, convert_audio, transcribe_audio.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import { ToolError } from '../errors/index.js';
import { runCommand } from './utils.js';

export const audioTools: NanoTool[] = [
  {
    name: 'download_audio',
    description:
      'Download audio from a URL using yt-dlp. Supports YouTube, Twitch, SoundCloud, ' +
      'and hundreds of other platforms. Returns the path to the downloaded audio file ' +
      'in /workspace/group/media/. Use convert_audio afterwards to change format, ' +
      'sample rate, or trim duration.',
    schema: z.object({
      url: z
        .string()
        .describe('URL to download audio from (YouTube, Twitch, SoundCloud, etc.)'),
      filename: z
        .string()
        .optional()
        .describe(
          'Output filename without extension (default: "downloaded_audio"). ' +
          'File will be saved as /workspace/group/media/{filename}.wav',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const url = (args.url as string).trim();
        if (!url) {
          return { content: 'URL is required', isError: true as const };
        }

        const filename = ((args.filename as string) || 'downloaded_audio').replace(
          /[^a-zA-Z0-9_-]/g,
          '_',
        );
        const mediaDir = '/workspace/group/media';
        fs.mkdirSync(mediaDir, { recursive: true });

        const outputTemplate = path.join(mediaDir, `${filename}.%(ext)s`);
        const expectedOutput = path.join(mediaDir, `${filename}.wav`);

        const { stdout: _stdout, stderr, exitCode } = yield* runCommand(
          [
            'yt-dlp',
            '-x',
            '--audio-format', 'wav',
            '--no-playlist',
            '--no-warnings',
            '-o', outputTemplate,
            url,
          ],
          120000,
        );

        if (exitCode !== 0) {
          return {
            content: `yt-dlp failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
            isError: true as const,
          };
        }

        if (fs.existsSync(expectedOutput)) {
          const stat = fs.statSync(expectedOutput);
          return {
            content: `Downloaded audio to: ${expectedOutput} (${(stat.size / 1024).toFixed(1)}KB)`,
          };
        }

        // Fallback: look for any file matching the filename pattern
        const files = fs.readdirSync(mediaDir).filter((f) => f.startsWith(filename));
        if (files.length > 0) {
          const found = path.join(mediaDir, files[files.length - 1]);
          const stat = fs.statSync(found);
          return {
            content: `Downloaded audio to: ${found} (${(stat.size / 1024).toFixed(1)}KB)`,
          };
        }

        return {
          content: `yt-dlp completed but output file not found. stderr: ${stderr.slice(0, 300)}`,
          isError: true as const,
        };
      }),
  },

  {
    name: 'download_video',
    description:
      'Download video from a URL using yt-dlp. Supports YouTube, Twitch, and hundreds ' +
      'of other platforms. Downloads best available quality and merges to mp4. ' +
      'Returns the path to the downloaded video file in /workspace/group/media/.',
    schema: z.object({
      url: z
        .string()
        .describe('URL to download video from (YouTube, Twitch, etc.)'),
      filename: z
        .string()
        .optional()
        .describe(
          'Output filename without extension (default: "downloaded_video"). ' +
          'File will be saved as /workspace/group/media/{filename}.mp4',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const url = (args.url as string).trim();
        if (!url) {
          return { content: 'URL is required', isError: true as const };
        }

        const filename = ((args.filename as string) || 'downloaded_video').replace(
          /[^a-zA-Z0-9_-]/g,
          '_',
        );
        const mediaDir = '/workspace/group/media';
        fs.mkdirSync(mediaDir, { recursive: true });

        const outputTemplate = path.join(mediaDir, `${filename}.%(ext)s`);
        const expectedOutput = path.join(mediaDir, `${filename}.mp4`);

        const { stdout: _stdout, stderr, exitCode } = yield* runCommand(
          [
            'yt-dlp',
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '-o', outputTemplate,
            url,
          ],
          300000,
        );

        if (exitCode !== 0) {
          return {
            content: `yt-dlp failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
            isError: true as const,
          };
        }

        if (fs.existsSync(expectedOutput)) {
          const stat = fs.statSync(expectedOutput);
          return {
            content: `Downloaded video to: ${expectedOutput} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
          };
        }

        // Fallback: look for any file matching the filename pattern
        const files = fs.readdirSync(mediaDir).filter((f) => f.startsWith(filename));
        if (files.length > 0) {
          const found = path.join(mediaDir, files[files.length - 1]);
          const stat = fs.statSync(found);
          return {
            content: `Downloaded video to: ${found} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
          };
        }

        return {
          content: `yt-dlp completed but output file not found. stderr: ${stderr.slice(0, 300)}`,
          isError: true as const,
        };
      }),
  },

  {
    name: 'convert_audio',
    description:
      'Convert or process audio files using ffmpeg. Supports format conversion, ' +
      'sample rate changes, mono/stereo conversion, and duration trimming. ' +
      'Ideal for preparing audio for voice cloning (24kHz mono WAV, max 10s).',
    schema: z.object({
      input_path: z
        .string()
        .describe('Path to input audio file (e.g., /workspace/group/media/downloaded_audio.wav)'),
      output_path: z
        .string()
        .optional()
        .describe(
          'Output path (default: /workspace/group/media/converted_audio.wav). ' +
          'Extension determines format if format is not specified.',
        ),
      sample_rate: z
        .number()
        .optional()
        .describe('Target sample rate in Hz (e.g., 24000 for voice cloning, 44100 for music)'),
      mono: z
        .boolean()
        .optional()
        .describe('Convert to mono (single channel). Recommended for voice cloning.'),
      max_duration: z
        .number()
        .optional()
        .describe('Maximum duration in seconds. Audio will be trimmed to this length.'),
      format: z
        .enum(['wav', 'mp3', 'ogg', 'flac', 'opus'])
        .optional()
        .describe('Output audio format (default: inferred from output_path extension, or wav)'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const inputPath = (args.input_path as string).trim();
        if (!inputPath) {
          return { content: 'input_path is required', isError: true as const };
        }
        if (!fs.existsSync(inputPath)) {
          return { content: `Input file not found: ${inputPath}`, isError: true as const };
        }

        const format = (args.format as string) || undefined;
        const defaultExt = format ? `.${format}` : '.wav';
        const outputPath =
          ((args.output_path as string) || '').trim() ||
          path.join(path.dirname(inputPath), `converted_audio${defaultExt}`);

        const ffmpegArgs = ['-i', inputPath];

        if (args.sample_rate) {
          ffmpegArgs.push('-ar', String(args.sample_rate));
        }
        if (args.mono) {
          ffmpegArgs.push('-ac', '1');
        }
        if (args.max_duration) {
          ffmpegArgs.push('-t', String(args.max_duration));
        }

        ffmpegArgs.push('-y', outputPath);

        const { stderr, exitCode } = yield* runCommand(
          ['ffmpeg', ...ffmpegArgs],
          60000,
        );

        if (exitCode !== 0) {
          return {
            content: `ffmpeg failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
            isError: true as const,
          };
        }

        if (!fs.existsSync(outputPath)) {
          return {
            content: `ffmpeg completed but output file not found: ${outputPath}`,
            isError: true as const,
          };
        }

        const stat = fs.statSync(outputPath);
        return {
          content: `Converted audio saved to: ${outputPath} (${(stat.size / 1024).toFixed(1)}KB)`,
        };
      }),
  },

  {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file to text using Replicate GPT-4o-transcribe. Useful for getting ' +
      'transcripts of voice recordings or reference audio for voice cloning. ' +
      'Requires REPLICATE_API_TOKEN.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to audio file (e.g., /workspace/group/media/voice_ref.wav)',
        ),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const apiToken = process.env.REPLICATE_API_TOKEN || '';
        if (!apiToken) {
          return {
            content: 'REPLICATE_API_TOKEN not configured. Ask the user for a transcript instead.',
            isError: true as const,
          };
        }

        const filePath = (args as { path: string }).path;
        if (!fs.existsSync(filePath)) {
          return { content: `File not found: ${filePath}`, isError: true as const };
        }

        const AUDIO_MIME: Record<string, string> = {
          '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4',
          '.mpeg': 'audio/mpeg', '.mpga': 'audio/mpeg', '.m4a': 'audio/mp4',
          '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav',
          '.webm': 'audio/webm',
        };

        const result = yield* Effect.tryPromise({
          try: async () => {
            const fileBuffer = fs.readFileSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mime = AUDIO_MIME[ext] || 'audio/wav';
            const base64 = fileBuffer.toString('base64');
            const dataUri = `data:${mime};base64,${base64}`;

            const createResp = await fetch('https://api.replicate.com/v1/predictions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'openai/gpt-4o-transcribe',
                input: { audio: dataUri },
              }),
            });

            if (!createResp.ok) {
              const detail = await createResp.text().catch(() => '');
              return {
                content: `Replicate API error ${createResp.status}: ${detail.slice(0, 200)}`,
                isError: true as const,
              };
            }

            const prediction = (await createResp.json()) as {
              id: string;
              status: string;
              output: { text: string } | null;
              error: string | null;
              urls: { get: string };
            };

            if (prediction.status === 'succeeded' && prediction.output?.text) {
              return { content: prediction.output.text };
            }
            if (prediction.status === 'failed') {
              return {
                content: `Transcription failed: ${prediction.error || 'unknown error'}`,
                isError: true as const,
              };
            }

            // Poll for completion (max 120s)
            const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1000));
              const pollResp = await fetch(pollUrl, {
                headers: { 'Authorization': `Bearer ${apiToken}` },
              });
              if (!pollResp.ok) continue;
              const result = (await pollResp.json()) as typeof prediction;
              if (result.status === 'succeeded' && result.output?.text) {
                return { content: result.output.text };
              }
              if (result.status === 'failed' || result.status === 'canceled') {
                return {
                  content: `Transcription failed: ${result.error || 'unknown error'}`,
                  isError: true as const,
                };
              }
            }

            return { content: 'Transcription timed out after 120s', isError: true as const };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'transcribe_audio',
              message: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },
];
