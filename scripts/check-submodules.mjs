#!/usr/bin/env node
/**
 * Fail a PR when a submodule is missing, uninitialized, or has an unexpected
 * game layout. The following build/test steps verify that it actually runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const status = git(['submodule', 'status', '--recursive']);
if (!status) {
  console.log('[check-submodules] no submodules configured');
  process.exit(0);
}

let failed = false;
for (const line of status.split('\n')) {
  const marker = line[0];
  const parts = line.slice(1).trim().split(/\s+/);
  const commit = parts[0];
  const dir = parts[1];
  if (marker === '-' || marker === '+') {
    console.error(`[check-submodules] not cleanly checked out: ${line}`);
    failed = true;
  }
  if (!commit || !dir) {
    console.error(`[check-submodules] unreadable status: ${line}`);
    failed = true;
    continue;
  }
  for (const required of ['README.md', 'game.ts', 'worker.ts', 'metadata.ts']) {
    if (!existsSync(path.join(dir, required))) {
      console.error(`[check-submodules] ${dir} is missing ${required}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`[check-submodules] ${status.split('\n').length} submodule(s) checked out`);
