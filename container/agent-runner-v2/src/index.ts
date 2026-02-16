/**
 * NanoClaw Agent Runner v2 — Effect-based container agent entry point.
 *
 * Phase 1: Minimal scaffolding. Supports mode detection but does not
 * yet process queries. Full implementation in Phase 3.
 */

import { Effect } from 'effect';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function log(msg: string): void {
  process.stderr.write(`[agent-runner-v2] ${msg}\n`);
}

const main = Effect.gen(function* () {
  const forcePersistent = process.env.NANOCLAW_PERSISTENT === '1';
  const isPiped = !process.stdin.isTTY;

  if (forcePersistent || !isPiped) {
    log('Persistent mode (Effect runtime) — not yet implemented');
    log('Phase 1 scaffolding only. Waiting for Phase 3 implementation.');
    // Phase 3: start Unix socket RPC server
  } else {
    log('One-shot mode (Effect runtime) — not yet implemented');
    // Phase 3: read stdin, process query, output result
    const output = JSON.stringify({
      status: 'error' as const,
      result: null,
      error: 'Agent runner v2 not yet implemented (Phase 1 scaffolding)',
    });
    console.log(OUTPUT_START_MARKER);
    console.log(output);
    console.log(OUTPUT_END_MARKER);
  }
});

Effect.runPromise(main).catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
