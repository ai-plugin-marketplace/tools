import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const coreBuildInfo = 'packages/core/tsconfig.tsbuildinfo';
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
    '.gitignore',
    'scripts/tsc/package.json',
    'scripts/tsc/tsc.mjs',
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
  const coreDependencies = join(workspace, 'packages/core/node_modules');
  if (existsSync(coreDependencies)) {
    symlinkSync(coreDependencies, join(checkout, 'packages/core/node_modules'), 'junction');
  }
  const cliDependencies = join(workspace, 'packages/cli/node_modules');
  const cliFixtureDependencies = join(checkout, 'packages/cli/node_modules');
  const cliLinkedScope = join(cliFixtureDependencies, '@ai-plugin-marketplace');
  mkdirSync(cliLinkedScope, { recursive: true });
  // Reuse installed dependencies while keeping the CLI linked to core within this fixture.
  if (existsSync(cliDependencies)) {
    for (const entry of readdirSync(cliDependencies)) {
      if (entry === '@ai-plugin-marketplace' || entry.startsWith('.')) continue;
      symlinkSync(join(cliDependencies, entry), join(cliFixtureDependencies, entry), 'junction');
    }
  }
  symlinkSync(join(checkout, 'packages/core'), join(cliLinkedScope, 'core'), 'junction');
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

function pnpmCommand(platform: NodeJS.Platform, args: string[]): [string, ...string[]] {
  // cmd.exe resolves either the standalone pnpm.exe or a pnpm.cmd shim. Arguments are fixed.
  return platform === 'win32' ? ['cmd.exe', '/d', '/c', 'pnpm', ...args] : ['pnpm', ...args];
}

function runPnpm(...args: string[]) {
  return runCommand(...pnpmCommand(process.platform, args));
}

function runCommand(command: string, ...commandArgs: string[]) {
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
          reject(new Error(`Unable to run ${command}.`, { cause: error }));
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

function publicInit(dir: string, cliVersion?: string) {
  return runCommand(
    process.execPath,
    '--input-type=module',
    '--eval',
    `import { init } from './packages/core/dist/index.js';
     const [dir, cliVersion] = process.argv.slice(1);
     await init(dir, cliVersion === undefined ? undefined : { cliVersion });`,
    dir,
    ...(cliVersion === undefined ? [] : [cliVersion]),
  );
}

async function assertPublicInit(dir: string, version: string): Promise<void> {
  const { status, stderr } = await publicInit(dir);
  expect(status, stderr).toBe(0);
  assertScaffoldedRelease(dir, version);
}

it('lets Windows resolve pnpm through PATHEXT', () => {
  expect(pnpmCommand('win32', ['exec', 'tsc', '--build'])).toEqual([
    'cmd.exe',
    '/d',
    '/c',
    'pnpm',
    'exec',
    'tsc',
    '--build',
  ]);
});

it.each([
  { path: 'workspace build', args: ['build'] },
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
    await assertPublicInit('initial', manifest.version);

    // Remove just the metadata, leaving TypeScript's incremental state and source unchanged.
    expect(statSync(join(checkout, coreBuildInfo)).isFile()).toBe(true);
    rmSync(join(checkout, bundledManifest));
    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(manifest);
    await assertPublicInit('recreated', manifest.version);

    const version = semver.inc(manifest.version, 'major');
    if (version === null) throw new Error('Expected a valid CLI release.');
    const updated = { ...manifest, version };
    writeFileSync(sourceManifest, JSON.stringify(updated));
    utimesSync(sourceManifest, oldTimestamp, oldTimestamp);
    expect(statSync(sourceManifest).mtimeMs).toBe(originalMtime);

    // The already-built CLI reads its own manifest while core still holds the previous bundle.
    const fromCli = await runCommand(
      process.execPath,
      'packages/cli/dist/bin.js',
      'init',
      'from-cli',
    );
    expect(fromCli.status, fromCli.stderr).toBe(0);
    expect(fromCli.stdout).toContain('Created plugin repo');
    assertScaffoldedRelease('from-cli', version);
    await assertPublicInit('still-bundled', manifest.version);

    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(updated);
    await assertPublicInit('updated', version);
  },
  190_000,
);

it('accepts stable shorthand and rejects it for the corresponding prerelease', async () => {
  const manifest = readManifest(cliManifest);
  writeFileSync(join(checkout, cliManifest), JSON.stringify({ ...manifest, version: '0.8.0' }));
  await assertPnpm('exec', 'tsc', '--build', 'packages/core');

  const stable = await publicInit('stable', '0.8');
  expect(stable.status, stable.stderr).toBe(0);
  assertScaffoldedRelease('stable', '0.8');

  writeFileSync(
    join(checkout, cliManifest),
    JSON.stringify({ ...manifest, version: '0.8.0-next.0' }),
  );
  await assertPnpm('exec', 'tsc', '--build', 'packages/core');
  await assertPublicInit('default-prerelease', '0.8.0-next.0');

  const prerelease = await publicInit('excluded-prerelease', '0.8');
  expect(prerelease.status).not.toBe(0);
  expect(prerelease.stderr).toContain('excludes @ai-plugin-marketplace/cli@0.8.0-next.0');
  expect(existsSync(join(checkout, 'excluded-prerelease'))).toBe(false);
}, 120_000);

it('rejects an invalid installed CLI manifest before writing the scaffold', async () => {
  await assertPnpm('exec', 'tsc', '--build');
  const manifest = { ...readManifest(cliManifest), name: '@example/invalid-cli' };
  writeFileSync(join(checkout, cliManifest), JSON.stringify(manifest));
  const result = await runCommand(
    process.execPath,
    'packages/cli/dist/bin.js',
    'init',
    'invalid-cli',
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Invalid CLI release metadata');
  expect(result.stdout).not.toContain('Created plugin repo');
  expect(existsSync(join(checkout, 'invalid-cli'))).toBe(false);
}, 60_000);

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
});

it('runs the core built-package smoke test directly from a clean checkout', async () => {
  await assertPnpm('--filter', corePackageName, 'run', 'test', 'src/pipeline/init-dist.test.ts');
});
