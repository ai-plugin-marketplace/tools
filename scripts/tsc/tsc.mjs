#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function workspaceRoot(dir) {
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the pnpm workspace.');
    dir = parent;
  }
  return dir;
}

function bundleCliManifest() {
  const root = workspaceRoot(process.cwd());
  const source = readFileSync(join(root, 'packages/cli/package.json'));
  const outDir = join(root, 'packages/core/dist/cli-release');
  const output = join(outDir, 'package.json');
  if (existsSync(output) && source.equals(readFileSync(output))) return;

  mkdirSync(outDir, { recursive: true });
  const temporary = join(outDir, `package-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, source);
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [compiler, ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

const builds = args[0] === '--build' || args[0] === '-b';
const skipsEmit = args.some((arg) =>
  ['--clean', '--dry', '--help', '-h', '--noEmit'].includes(arg),
);
if (result.status === 0 && builds && !skipsEmit) bundleCliManifest();
