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

  const parsedAttemptCount = Number.parseInt(
    process.env.SETUP_BUN_INSTALL_MAX_ATTEMPTS ?? '3',
    10,
  );
  const maxAttempts =
    Number.isNaN(parsedAttemptCount) || parsedAttemptCount < 1 ? 3 : parsedAttemptCount;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`Retrying bun install (${attempt}/${maxAttempts})...`);
      console.log('');
    }

    const proc = Bun.spawnSync(['bun', 'install'], {
      cwd: DEST_DIR,
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    if (proc.exitCode === 0) {
      console.log('');
      return;
    }

    console.log('');
    if (attempt < maxAttempts) {
      console.log(`bun install failed on attempt ${attempt}/${maxAttempts}`);
      console.log('');
      continue;
    }

    console.log(
      `WARNING: bun install failed after ${maxAttempts} attempt(s). Continuing setup without dependencies installed.`,
    );
    console.log('Run `bun install` manually when you are ready.');
  }

  console.log('');
}

main();
