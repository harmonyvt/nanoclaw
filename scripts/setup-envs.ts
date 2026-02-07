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

const SOURCE_DIR =
  process.env.NANOCLAW_ENV_SOURCE_DIR ||
  path.join(process.env.HOME || '', 'nanoclaw');
const DEST_DIR = path.resolve(import.meta.dir, '..');

function main(): void {
  console.log('');
  console.log('Setting up environment files...');
  console.log('');

  // Skip if we're already in the source directory.
  if (path.resolve(SOURCE_DIR) === path.resolve(DEST_DIR)) {
    console.log('  Already in source directory, nothing to copy');
    console.log('');
    runBunInstall();
    return;
  }

  // Check source directory exists.
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log(`  Source directory not found: ${SOURCE_DIR}`);
    console.log('');
    process.exit(1);
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

main();

