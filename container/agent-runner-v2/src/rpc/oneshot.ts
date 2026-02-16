/**
 * One-shot mode: read JSON from stdin, process single query, write result to stdout.
 * Uses sentinel markers for robust JSON extraction by the host.
 */

import { Effect, Schema } from 'effect';
import { ContainerInput, type ContainerOutput } from '../schemas/ContainerIO.js';

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function log(msg: string): void {
  process.stderr.write(`[oneshot] ${msg}\n`);
}

/** Read all of stdin as a string. */
export const readStdinJson: Effect.Effect<unknown, Error> = Effect.tryPromise({
  try: () =>
    new Promise<unknown>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse stdin JSON: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      process.stdin.on('error', reject);
    }),
  catch: (err) => new Error(`Stdin read failed: ${err instanceof Error ? err.message : String(err)}`),
});

/** Validate raw JSON against ContainerInput schema. */
export function decodeContainerInput(raw: unknown): Effect.Effect<ContainerInput, Error> {
  return Effect.tryPromise({
    try: () => Schema.decodeUnknownPromise(ContainerInput)(raw),
    catch: (err) => new Error(`Invalid container input: ${err instanceof Error ? err.message : String(err)}`),
  });
}

/** Write output between sentinel markers. */
export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Run one-shot mode: reads stdin, runs the query handler, writes output.
 * The actual query execution is delegated to the provided handler so that
 * the entry point can wire up the right Layer composition.
 */
export function runOneShot(
  handler: (input: ContainerInput) => Promise<ContainerOutput>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const raw = yield* readStdinJson.pipe(
      Effect.catchAll((err) => {
        writeOutput({
          status: 'error',
          result: null,
          error: `Failed to read stdin: ${err.message}`,
        });
        return Effect.succeed(null);
      }),
    );

    if (raw === null) return;

    const input = yield* decodeContainerInput(raw).pipe(
      Effect.catchAll((err) => {
        writeOutput({
          status: 'error',
          result: null,
          error: err.message,
        });
        return Effect.succeed(null);
      }),
    );

    if (input === null) return;

    log(`Received input for group: ${input.groupFolder}`);

    const output = yield* Effect.tryPromise({
      try: () => handler(input),
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) =>
        Effect.succeed({
          status: 'error' as const,
          result: null,
          error: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      ),
    );

    writeOutput(output);
  });
}
