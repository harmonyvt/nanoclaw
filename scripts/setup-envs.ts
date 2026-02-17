#!/usr/bin/env bun
/**
 * Setup Environment Files Script
 *
 * Copies .env* files from ~/nanoclaw to the current worktree.
 *
 * Usage:
 *   bun run setup:envs
 */

import * as fs from 'fs';
import * as path from 'path';
import { Glob } from 'bun';

function resolveSourceDir(): string {
  const sourceCandidates: string[] = []

  const repoName = 'nanoclaw';
  const home = process.env.HOME || '';
  const sourceEnv = process.env.NANOCLAW_ENV_SOURCE_DIR;
  const standardSource = path.join(home, repoName);
  const worktreeRoot = path.join(home, '.codex', 'worktrees');

  if (sourceEnv) {
    sourceCandidates.push(sourceEnv);
  }

  sourceCandidates.push(standardSource);

  try {
    if (fs.existsSync(worktreeRoot)) {
      for (const entry of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        sourceCandidates.push(path.join(worktreeRoot, entry.name, repoName));
      }
    }
  } catch {
    // Ignore source directory probe failures.
  }

  const uniqueCandidates = [...new Set(sourceCandidates.map((candidate) => path.resolve(candidate)))];
  const resolvedDest = path.resolve(DEST_DIR);

  for (const candidate of uniqueCandidates) {
    if (candidate && candidate !== resolvedDest && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return standardSource;
}

const DEST_DIR = path.resolve(import.meta.dir, '..');
const SOURCE_DIR = resolveSourceDir();

function main(): void {
  console.log('');
  console.log('Setting up environment files...');
  console.log('');

  // Check source directory exists.
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log(`  Source directory not found: ${SOURCE_DIR}`);
    console.log('');
    process.exit(1);
  }

  console.log(`Using source directory: ${SOURCE_DIR}`);
  console.log('');

  ensureSourceMainIsUpToDate();

  // Skip copy if we're already in the source directory.
  if (path.resolve(SOURCE_DIR) === path.resolve(DEST_DIR)) {
    console.log('  Already in source directory, nothing to copy');
    console.log('');
    runBunInstall();
    return;
  }

  // Find .env* files in source directory.
  const glob = new Glob('.env*');
  const envFiles = [...glob.scanSync({ cwd: SOURCE_DIR, dot: true })];

  if (envFiles.length === 0) {
    console.log(`  No .env files found in ${SOURCE_DIR}`);
    console.log('');
    runBunInstall();
    return;
  }

  let copiedCount = 0;

  for (const envFile of envFiles) {
    const srcPath = path.join(SOURCE_DIR, envFile);
    const destPath = path.join(DEST_DIR, envFile);

    try {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  Copied ${envFile}`);
      copiedCount += 1;
    } catch (err) {
      console.log(`  Failed ${envFile} (${String(err)})`);
    }
  }

  console.log('');
  console.log(`Done! Copied ${copiedCount} .env files`);
  console.log('');

  runBunInstall();
}

function runBunInstall(): void {
  console.log('Installing dependencies...');
  console.log('');

  const proc = Bun.spawnSync(['bun', 'install'], {
    cwd: DEST_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (proc.exitCode !== 0) {
    console.log('');
    console.log('Failed to install dependencies');
    process.exit(1);
  }

  console.log('');
}

function ensureSourceMainIsUpToDate(): void {
  console.log('Checking source main branch is up to date with origin/main...');
  console.log('');

  const fetchProc = runGitInSource(['fetch', '--quiet', 'origin', 'main']);
  if (fetchProc.exitCode !== 0) {
    console.log('  ✗ Failed to fetch origin/main in source repository');
    console.log('');
    process.exit(1);
  }

  const divergence = getMainDivergence();
  if (!divergence) {
    console.log('  ✗ Could not resolve main and/or origin/main in source repository');
    console.log('');
    process.exit(1);
  }

  if (divergence.aheadCount === 0 && divergence.behindCount === 0) {
    console.log('  ✓ Source main is up to date with origin/main');
    console.log('');
    return;
  }

  if (divergence.aheadCount === 0 && divergence.behindCount > 0) {
    console.log(`  Source main is behind origin/main by ${divergence.behindCount} commit(s); syncing...`);

    const currentBranch = readGitStdout(['rev-parse', '--abbrev-ref', 'HEAD']);
    const syncProc =
      currentBranch === 'main'
        ? runGitInSource(['pull', '--ff-only', 'origin', 'main'])
        : runGitInSource(['branch', '-f', 'main', 'origin/main']);

    if (syncProc.exitCode !== 0) {
      console.log('  ✗ Failed to sync source main with origin/main');
      console.log(`  Run: git -C "${SOURCE_DIR}" checkout main && git -C "${SOURCE_DIR}" pull --ff-only`);
      console.log('');
      process.exit(1);
    }

    const postSyncDivergence = getMainDivergence();
    if (!postSyncDivergence || postSyncDivergence.aheadCount !== 0 || postSyncDivergence.behindCount !== 0) {
      console.log('  ✗ Source main sync did not complete cleanly');
      console.log(`  Run: git -C "${SOURCE_DIR}" checkout main && git -C "${SOURCE_DIR}" pull --ff-only`);
      console.log('');
      process.exit(1);
    }

    console.log('  ✓ Source main synced to origin/main');
    console.log('');
    return;
  }

  console.log(
    `  ✗ Source main is not fast-forwardable to origin/main (ahead: ${divergence.aheadCount}, behind: ${divergence.behindCount})`,
  );
  console.log(`  Run: git -C "${SOURCE_DIR}" checkout main && git -C "${SOURCE_DIR}" pull --ff-only`);
  console.log('');
  process.exit(1);
}

function getMainDivergence(): { aheadCount: number; behindCount: number } | null {
  const divergence = readGitStdout([
    'rev-list',
    '--left-right',
    '--count',
    'main...origin/main',
  ]);
  if (!divergence) return null;

  const [aheadRaw = '', behindRaw = ''] = divergence.split(/\s+/);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  const behindCount = Number.parseInt(behindRaw, 10);

  if (Number.isNaN(aheadCount) || Number.isNaN(behindCount)) return null;

  return { aheadCount, behindCount };
}

function runGitInSource(args: string[]) {
  return Bun.spawnSync(['git', '-C', SOURCE_DIR, ...args]);
}

function readGitStdout(args: string[]): string | null {
  const proc = runGitInSource(args);
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout).trim();
}

main();
