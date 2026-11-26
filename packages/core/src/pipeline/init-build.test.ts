import { execFile, execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { afterEach, beforeEach, expect, it } from 'vitest';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const corePackageName = '@ai-plugin-marketplace/core';
const cliPackageName = '@ai-plugin-marketplace/cli';
const bundledManifest = 'packages/core/dist/cli-release/package.json';
const releaseBuildInfo = 'packages/core/dist/cli-release/cli-release.tsbuildinfo';
const cliManifest = 'packages/cli/package.json';

let checkout: string;

beforeEach(() => {
  checkout = mkdtempSync(join(tmpdir(), 'aipm-build-'));
  for (const file of [
    'package.json',
    'pnpm-workspace.yaml',
    'nx.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'api-extractor-base.json',
    'patches',
  ]) {
    cpSync(join(workspace, file), join(checkout, file), { recursive: true });
  }
  for (const pkg of ['core', 'cli']) {
    const relative = join('packages', pkg);
    cpSync(join(workspace, relative), join(checkout, relative), {
      recursive: true,
      filter: (entry) => !/^(node_modules|dist|temp)$|(\.tsbuildinfo|\.tgz)$/.test(basename(entry)),
    });
  }

  symlinkSync(join(workspace, 'node_modules'), join(checkout, 'node_modules'), 'junction');
  symlinkSync(
    join(workspace, 'packages/core/node_modules'),
    join(checkout, 'packages/core/node_modules'),
    'junction',
  );
  const cliLinkedScope = join(checkout, 'packages/cli/node_modules/@ai-plugin-marketplace');
  mkdirSync(cliLinkedScope, { recursive: true });
  symlinkSync(join(checkout, 'packages/core'), join(cliLinkedScope, 'core'), 'junction');
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

function runPnpm(...args: string[]) {
  // Windows exposes pnpm through a .cmd shim. These arguments are fixed test commands.
  const windows = process.platform === 'win32';
  const command = windows ? 'cmd.exe' : 'pnpm';
  const commandArgs = windows ? ['/d', '/c', 'pnpm.cmd', ...args] : args;
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      commandArgs,
      {
        cwd: checkout,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NX_DAEMON: 'false' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error('Unable to run pnpm.', { cause: error }));
          return;
        }
        resolve({ status: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

async function assertPnpm(...args: string[]): Promise<void> {
  const { status, stdout, stderr } = await runPnpm(...args);
  expect(status, stdout + stderr).toBe(0);
}

function readManifest(file: string): { version: string; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(checkout, file), 'utf8')) as {
    version: string;
    devDependencies?: Record<string, string>;
  };
}

function assertScaffoldedRelease(dir: string, version: string): void {
  const { devDependencies } = readManifest(dir + '/package.json');
  expect(devDependencies?.[cliPackageName]).toBe('^' + version);
  expect(devDependencies?.[corePackageName]).toBe(
    '^' + readManifest('packages/core/package.json').version,
  );
}

function assertPublicInit(dir: string, version: string): void {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { init } from '@ai-plugin-marketplace/core'; await init(process.argv[1]);",
      join(checkout, dir),
    ],
    { cwd: join(checkout, 'packages/core') },
  );
  assertScaffoldedRelease(dir, version);
}

it.each([
  { path: 'workspace build', args: ['build', '--skip-nx-cache'] },
  { path: 'TypeScript project references', args: ['exec', 'tsc', '--build'] },
  { path: 'CLI package build', args: ['--filter', cliPackageName, 'run', 'build'] },
])(
  'bundles the CLI manifest on clean and incremental $path',
  async ({ args }) => {
    const sourceManifest = join(checkout, cliManifest);
    // Set a timestamp the filesystem can restore exactly before the first build.
    const oldTimestamp = new Date(Math.floor(statSync(sourceManifest).mtimeMs / 1000) * 1000);
    utimesSync(sourceManifest, oldTimestamp, oldTimestamp);
    const originalMtime = statSync(sourceManifest).mtimeMs;
    const manifest = readManifest(cliManifest);
    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(manifest);
    assertPublicInit('initial', manifest.version);

    // Remove just the output and retain the metadata project's incremental build state.
    const buildInfo = join(checkout, releaseBuildInfo);
    expect(statSync(buildInfo).isFile()).toBe(true);
    rmSync(join(checkout, bundledManifest));
    const initSource = join(checkout, 'packages/core/src/pipeline/init.ts');
    writeFileSync(initSource, readFileSync(initSource, 'utf8') + '\n// Incremental build probe.\n');
    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(manifest);
    assertPublicInit('recreated', manifest.version);

    const version = semver.inc(manifest.version, 'major');
    if (version === null) throw new Error('Expected a valid CLI release.');
    const updated = { ...manifest, version };
    writeFileSync(sourceManifest, JSON.stringify(updated));
    utimesSync(sourceManifest, oldTimestamp, oldTimestamp);
    expect(statSync(sourceManifest).mtimeMs).toBe(originalMtime);

    // The already-built CLI reads its own manifest while core still holds the previous bundle.
    execFileSync(process.execPath, ['packages/cli/dist/bin.js', 'init', 'from-cli'], {
      cwd: checkout,
    });
    assertScaffoldedRelease('from-cli', version);
    assertPublicInit('still-bundled', manifest.version);

    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(updated);
    assertPublicInit('updated', version);
  },
  190_000,
);

it('refuses to pack core with missing or stale metadata', async () => {
  const pack = ['--filter', corePackageName, 'pack', '--json'];
  const missing = await runPnpm(...pack);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('Bundled CLI release metadata is missing');

  await assertPnpm('exec', 'tsc', '--build', 'packages/core');
  const bundled = readManifest(bundledManifest);
  writeFileSync(join(checkout, bundledManifest), JSON.stringify({ ...bundled, version: '0.0.0' }));
  const stale = await runPnpm(...pack);
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain('Bundled CLI release metadata is stale');

  writeFileSync(join(checkout, bundledManifest), JSON.stringify(bundled));
  const packed = await runPnpm(...pack);
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  expect(packed.stdout).toContain('dist/cli-release/package.json');
  expect(packed.stdout).not.toContain('cli-release.tsbuildinfo');
});

it('runs the core built-package smoke test directly from a clean checkout', async () => {
  await assertPnpm('--filter', corePackageName, 'run', 'test', 'src/pipeline/init-dist.test.ts');
});
