import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  ]) {
    cpSync(join(workspace, file), join(checkout, file));
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
  const result = spawnSync('pnpm', args, {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NX_DAEMON: 'false' },
  });
  if (result.error) throw result.error;
  return result;
}

function assertPnpm(...args: string[]): void {
  const { status, stdout, stderr } = runPnpm(...args);
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
  ({ args }) => {
    const manifest = readManifest(cliManifest);
    assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(manifest);
    assertPublicInit('initial', manifest.version);

    const version = semver.inc(manifest.version, 'major');
    if (version === null) throw new Error('Expected a valid CLI release.');
    const updated = { ...manifest, version };
    writeFileSync(join(checkout, cliManifest), JSON.stringify(updated));

    // The already-built CLI reads its own manifest while core still holds the previous bundle.
    execFileSync(process.execPath, ['packages/cli/dist/bin.js', 'init', 'from-cli'], {
      cwd: checkout,
    });
    assertScaffoldedRelease('from-cli', version);
    assertPublicInit('still-bundled', manifest.version);

    assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual(updated);
    assertPublicInit('updated', version);
  },
  60_000,
);

it('refuses to pack core with missing or stale metadata', () => {
  const pack = ['--filter', corePackageName, 'pack', '--json'];
  const missing = runPnpm(...pack);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('Bundled CLI release metadata is missing');

  assertPnpm('exec', 'tsc', '--build', 'packages/core');
  const bundled = readManifest(bundledManifest);
  writeFileSync(join(checkout, bundledManifest), JSON.stringify({ ...bundled, version: '0.0.0' }));
  const stale = runPnpm(...pack);
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain('Bundled CLI release metadata is stale');

  writeFileSync(join(checkout, bundledManifest), JSON.stringify(bundled));
  const packed = runPnpm(...pack);
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  expect(packed.stdout).toContain('dist/cli-release/package.json');
});

it('runs the core built-package smoke test directly from a clean checkout', () => {
  assertPnpm('--filter', corePackageName, 'run', 'test', 'src/pipeline/init-dist.test.ts');
});
