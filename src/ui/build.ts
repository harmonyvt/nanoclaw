import { existsSync, rmSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dir, '../..');
const OUT_DIR = join(ROOT, 'dist/ui');

// Clean stale outputs before rebuilding (chunks get hashed names that change each build)
if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true });
}
mkdirSync(OUT_DIR, { recursive: true });

const entryPoints = [
  { name: 'takeover', path: join(ROOT, 'src/ui/takeover/takeover.tsx') },
  { name: 'dashboard', path: join(ROOT, 'src/ui/dashboard/dashboard.tsx') },
  { name: 'follow', path: join(ROOT, 'src/ui/follow/follow.tsx') },
];

// Check entry points exist
const missing = entryPoints.filter((e) => !existsSync(e.path));
if (missing.length > 0) {
  for (const m of missing) {
    console.warn(`[build:ui] Warning: entry point not found: ${m.path}`);
  }
}

const validEntries = entryPoints.filter((e) => existsSync(e.path));

if (validEntries.length === 0) {
  console.warn('[build:ui] No entry points found, skipping JS bundle.');
} else {
  const result = await Bun.build({
    entrypoints: validEntries.map((e) => e.path),
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: true,
    naming: '[name].[ext]',
  });

  if (!result.success) {
    console.error('[build:ui] JS bundle failed:');
    for (const log of result.logs) {
      console.error(' ', log);
    }
    process.exit(1);
  }

  console.log(`[build:ui] JS bundle OK: ${result.outputs.length} file(s) -> dist/ui/`);
}

// --- CSS concatenation ---

const SHARED_DIR = join(ROOT, 'src/ui/shared');

interface CssTarget {
  name: string;
  files: string[];
}

const cssTargets: CssTarget[] = [
  {
    name: 'takeover',
    files: [
      join(SHARED_DIR, 'theme.css'),
      join(SHARED_DIR, 'components.css'),
      join(ROOT, 'src/ui/takeover/takeover.css'),
    ],
  },
  {
    name: 'dashboard',
    files: [
      join(SHARED_DIR, 'theme.css'),
      join(SHARED_DIR, 'components.css'),
      join(ROOT, 'src/ui/dashboard/dashboard.css'),
    ],
  },
  {
    name: 'follow',
    files: [
      join(SHARED_DIR, 'theme.css'),
      join(SHARED_DIR, 'components.css'),
      join(ROOT, 'src/ui/follow/follow.css'),
    ],
  },
];

for (const target of cssTargets) {
  const parts: string[] = [];
  for (const file of target.files) {
    if (existsSync(file)) {
      parts.push(await Bun.file(file).text());
    }
  }
  const outPath = join(OUT_DIR, `${target.name}.css`);
  await Bun.write(outPath, parts.join('\n'));
  console.log(`[build:ui] CSS OK: ${target.name}.css`);
}

console.log('[build:ui] Done.');
