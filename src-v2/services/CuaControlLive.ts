/**
 * CuaControlLive — CUA command transport with compatibility normalization.
 */

import { Buffer } from 'buffer';
import { Effect, Layer } from 'effect';

import { CUA_COMMAND_CATALOG } from '../generated/cua-commands.generated.js';
import type { paths } from '../generated/cua-openapi.generated.js';
import { BrowseError } from '../errors.js';
import { Sandbox } from './Sandbox.js';
import { CuaControl } from './CuaControl.js';
import type {
  CuaCommandAttempt,
  CuaControlService,
} from './CuaControl.js';

type CmdRequestBody = paths['/cmd']['post']['requestBody'] extends {
  content: { 'application/json': infer T };
}
  ? T
  : Record<string, unknown>;

type CuaPayload = {
  status?: string;
  success?: boolean;
  content?: unknown;
  result?: unknown;
  output?: unknown;
  error?: string;
  message?: string;
};

function detectImageMimeFromBytes(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (bytes.length >= 6) {
    const sig6 = bytes.subarray(0, 6).toString('ascii');
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function parseSsePayload(raw: string): unknown {
  const dataLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');

  if (dataLines.length === 0) return {};

  let last: unknown = {};
  for (const entry of dataLines) {
    try {
      const parsed = JSON.parse(entry) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parsed, 'result')) {
        last = parsed.result;
      } else if (Object.prototype.hasOwnProperty.call(parsed, 'content')) {
        last = parsed.content;
      } else {
        last = parsed;
      }
    } catch {
      last = entry;
    }
  }

  return last;
}

function isKnownCommand(command: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      CUA_COMMAND_CATALOG.commands || {},
      command,
    ) ||
    Object.prototype.hasOwnProperty.call(
      CUA_COMMAND_CATALOG.aliases || {},
      command,
    )
  );
}

function resolveCommandName(command: string): string {
  const aliasMap = CUA_COMMAND_CATALOG.aliases || {};
  const mapped = aliasMap[command as keyof typeof aliasMap];
  if (typeof mapped === 'string' && mapped) {
    return mapped;
  }
  return command;
}

function pickKnownParams(
  command: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const commands = CUA_COMMAND_CATALOG.commands || {};
  const definition = commands[command as keyof typeof commands];
  const paramDefs = definition?.params || [];
  const names = paramDefs
    .map((entry) => entry?.name)
    .filter(
      (name) => typeof name === 'string' && name.length > 0,
    ) as string[];

  if (names.length === 0) return params;

  const picked: Record<string, unknown> = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      picked[name] = params[name];
    }
  }

  return Object.keys(picked).length > 0 ? picked : params;
}

function normalizeParams(
  command: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...params };

  switch (command) {
    case 'open': {
      if (normalized.target === undefined) {
        const target = normalized.target ?? normalized.url ?? normalized.uri;
        if (typeof target === 'string' && target.trim()) {
          normalized.target = target;
        }
      }
      break;
    }
    case 'run_command': {
      if (
        normalized.command === undefined &&
        typeof normalized.cmd === 'string' &&
        normalized.cmd.trim()
      ) {
        normalized.command = normalized.cmd;
      }
      break;
    }
    case 'find_element': {
      if (normalized.title === undefined) {
        const titleCandidate =
          normalized.title ??
          normalized.description ??
          normalized.query ??
          normalized.selector;
        if (
          typeof titleCandidate === 'string' &&
          titleCandidate.trim()
        ) {
          normalized.title = titleCandidate;
        }
      }
      break;
    }
    case 'scroll': {
      if (normalized.x === undefined) {
        const mappedX =
          normalized.x ??
          normalized.delta_x ??
          normalized.deltaX ??
          normalized.dx;
        normalized.x = typeof mappedX === 'number' ? mappedX : 0;
      }
      if (normalized.y === undefined) {
        const mappedY =
          normalized.y ??
          normalized.delta_y ??
          normalized.deltaY ??
          normalized.dy;
        normalized.y = typeof mappedY === 'number' ? mappedY : 0;
      }
      break;
    }
    default:
      break;
  }

  return pickKnownParams(command, normalized);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export const CuaControlLive: Layer.Layer<CuaControl, never, Sandbox> = Layer.effect(
  CuaControl,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    const command = (
      rawCommand: string,
      args: Record<string, unknown> = {},
    ): Effect.Effect<unknown, BrowseError> =>
      Effect.gen(function* () {
        const conn = yield* sandbox.ensure.pipe(
          Effect.mapError(
            (err) =>
              new BrowseError({
                message: `CUA sandbox unavailable: ${err.message}`,
                action: rawCommand,
                cause: err,
              }),
          ),
        );
        yield* sandbox.resetIdle;

        return yield* Effect.tryPromise({
          try: async () => {
            const resolvedCommand = resolveCommandName(rawCommand);
            const normalizedParams = normalizeParams(resolvedCommand, args);
            const body = {
              command: resolvedCommand,
              params: normalizedParams,
              args: normalizedParams,
            } as CmdRequestBody & Record<string, unknown>;

            const response = await fetch(conn.commandUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });

            const contentType = (
              response.headers.get('content-type') || ''
            ).toLowerCase();
            const responseBytes = Buffer.from(await response.arrayBuffer());

            if (!response.ok) {
              const rawBody = responseBytes.toString('utf8');
              throw new Error(
                `CUA command HTTP ${response.status}: ${rawBody.slice(0, 500)}`,
              );
            }

            if (
              contentType.includes('image/') ||
              contentType.includes('application/octet-stream')
            ) {
              const mimeType = contentType.split(';', 1)[0] || 'image/png';
              return `data:${mimeType};base64,${responseBytes.toString('base64')}`;
            }

            if (resolvedCommand === 'screenshot') {
              const detectedMime = detectImageMimeFromBytes(responseBytes);
              if (detectedMime) {
                return `data:${detectedMime};base64,${responseBytes.toString('base64')}`;
              }
            }

            const rawBody = responseBytes.toString('utf8');

            let payload: CuaPayload;
            if (contentType.includes('text/event-stream')) {
              const streamed = parseSsePayload(rawBody);
              payload =
                streamed && typeof streamed === 'object'
                  ? (streamed as CuaPayload)
                  : { content: streamed };
            } else {
              try {
                payload = JSON.parse(rawBody) as CuaPayload;
              } catch {
                payload = { content: rawBody };
              }
            }

            if (
              payload.status &&
              payload.status !== 'success' &&
              payload.status !== 'ok'
            ) {
              throw new Error(
                payload.error || payload.message || `CUA command failed: ${resolvedCommand}`,
              );
            }
            if (payload.success === false) {
              throw new Error(
                payload.error || payload.message || `CUA command failed: ${resolvedCommand}`,
              );
            }
            if (payload.error) {
              throw new Error(payload.error);
            }

            if (Object.prototype.hasOwnProperty.call(payload, 'content')) {
              return payload.content;
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'result')) {
              return payload.result;
            }

            return payload;
          },
          catch: (err) =>
            new BrowseError({
              message: `CUA command failed: ${err instanceof Error ? err.message : String(err)}`,
              action: rawCommand,
              cause: err,
            }),
        });
      });

    const commandWithFallback = (
      attempts: ReadonlyArray<CuaCommandAttempt>,
    ): Effect.Effect<unknown, BrowseError> =>
      Effect.gen(function* () {
        let lastError: BrowseError | null = null;

        for (const attempt of attempts) {
          if (!isKnownCommand(attempt.command)) continue;

          const result = yield* command(
            attempt.command,
            attempt.args || {},
          ).pipe(Effect.either);

          if (result._tag === 'Right') {
            return result.right;
          }

          lastError = result.left;
        }

        if (lastError) {
          return yield* Effect.fail(lastError);
        }

        return yield* Effect.fail(
          new BrowseError({
            message:
              'CUA command fallback failed: no compatible command succeeded',
            action: attempts[0]?.command || 'unknown',
          }),
        );
      });

    const service: CuaControlService = {
      command,
      commandWithFallback,
      isKnownCommand,
      shellSingleQuote,
    };

    return service;
  }),
);
