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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { afterEach, beforeEach, expect, it } from 'vitest';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
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
    '.github/scripts',
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
  return runPnpmAt(checkout, ...args);
}

function runPnpmAt(cwd: string, ...args: string[]) {
  return runCommandAt(cwd, ...pnpmCommand(process.platform, args));
}

function runCommand(command: string, ...args: string[]) {
  return runCommandAt(checkout, command, ...args);
}

function runCommandAt(cwd: string, command: string, ...commandArgs: string[]) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      commandArgs,
      {
        cwd,
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

function readManifest(
  file: string,
  directory = checkout,
): { version: string; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(directory, file), 'utf8')) as {
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
  {
    path: 'Nx CLI build and its core dependency',
    args: ['exec', 'nx', 'run', `${cliPackageName}:build`],
  },
])(
  'bundles the CLI release identity on clean and incremental $path',
  async ({ args }) => {
    const sourceManifest = join(checkout, cliManifest);
    // Set a timestamp the filesystem can restore exactly before the first build.
    const oldTimestamp = new Date(Math.floor(statSync(sourceManifest).mtimeMs / 1000) * 1000);
    utimesSync(sourceManifest, oldTimestamp, oldTimestamp);
    const originalMtime = statSync(sourceManifest).mtimeMs;
    const manifest = readManifest(cliManifest);
    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual({
      name: cliPackageName,
      version: manifest.version,
    });
    await assertPublicInit('initial', manifest.version);

    // Remove just the metadata, leaving TypeScript's incremental state and source unchanged.
    expect(statSync(join(checkout, coreBuildInfo)).isFile()).toBe(true);
    rmSync(join(checkout, bundledManifest));
    await assertPnpm(...args);
    expect(readManifest(bundledManifest)).toEqual({
      name: cliPackageName,
      version: manifest.version,
    });
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
    expect(readManifest(bundledManifest)).toEqual({ name: cliPackageName, version });
    await assertPublicInit('updated', version);

    rmSync(join(checkout, 'packages/core/dist'), { recursive: true });
    const cached = await runPnpm(...args);
    expect(cached.status, cached.stdout + cached.stderr).toBe(0);
    expect(cached.stdout).toMatch(/read the output from the cache/i);
    expect(readManifest(bundledManifest)).toEqual({ name: cliPackageName, version });
    expect(existsSync(join(checkout, 'packages/core/dist/core.d.ts'))).toBe(true);
    await assertPublicInit('cached', version);
  },
  250_000,
);

it('accepts stable shorthand and rejects it for the corresponding prerelease', async () => {
  const manifest = readManifest(cliManifest);
  writeFileSync(join(checkout, cliManifest), JSON.stringify({ ...manifest, version: '0.8.0' }));
  await assertPnpm('--filter', corePackageName, 'build');

  const stable = await publicInit('stable', '0.8');
  expect(stable.status, stable.stderr).toBe(0);
  assertScaffoldedRelease('stable', '0.8');

  writeFileSync(
    join(checkout, cliManifest),
    JSON.stringify({ ...manifest, version: '0.8.0-next.0' }),
  );
  await assertPnpm('--filter', corePackageName, 'build');
  await assertPublicInit('default-prerelease', '0.8.0-next.0');

  const prerelease = await publicInit('excluded-prerelease', '0.8');
  expect(prerelease.status).not.toBe(0);
  expect(prerelease.stderr).toContain('excludes @ai-plugin-marketplace/cli@0.8.0-next.0');
  expect(existsSync(join(checkout, 'excluded-prerelease'))).toBe(false);
}, 120_000);

it('rejects an invalid installed CLI manifest before writing the scaffold', async () => {
  await assertPnpm('build');
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

it('fails closed after a clean direct TypeScript build', async () => {
  const result = await runCommand(process.execPath, tsc, '--build');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(existsSync(join(checkout, 'packages/core/dist/index.js'))).toBe(true);
  expect(existsSync(join(checkout, bundledManifest))).toBe(false);

  const init = await publicInit('compiler-only');
  expect(init.status).not.toBe(0);
  expect(init.stderr).toContain('CLI release metadata is missing');
  expect(existsSync(join(checkout, 'compiler-only'))).toBe(false);
}, 60_000);

it('refuses to pack core with missing, invalid, or stale metadata or missing entry points', async () => {
  const pack = ['--filter', corePackageName, 'pack', '--out', 'core.tgz'];

  async function assertPackRefused(message: string) {
    const result = await runPnpm(...pack);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(join(checkout, 'core.tgz'))).toBe(false);
  }

  await assertPackRefused('Bundled CLI release metadata is missing');
  await assertPnpm('--filter', corePackageName, 'build');
  const bundledPath = join(checkout, bundledManifest);
  const sourcePath = join(checkout, cliManifest);
  const original = readFileSync(sourcePath);
  const bundled = readManifest(bundledManifest);

  for (const invalid of [
    { ...bundled, version: 'invalid' },
    { ...bundled, name: '@example/invalid-cli' },
    { ...bundled, version: '9007199254740991.0.0' },
  ]) {
    const json = JSON.stringify(invalid);
    writeFileSync(sourcePath, json);
    writeFileSync(bundledPath, json);
    await assertPackRefused('Invalid CLI release metadata');

    const init = await publicInit('invalid');
    expect(init.status).not.toBe(0);
    expect(init.stderr).toContain('Invalid CLI release metadata');
    expect(existsSync(join(checkout, 'invalid'))).toBe(false);
  }

  writeFileSync(sourcePath, original);
  writeFileSync(bundledPath, '{');
  await assertPackRefused('Invalid CLI release metadata');
  const malformed = await publicInit('malformed');
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).toContain('Invalid CLI release metadata');
  expect(existsSync(join(checkout, 'malformed'))).toBe(false);

  const version = semver.inc(bundled.version, 'major');
  if (version === null) throw new Error('Expected a valid CLI release.');
  writeFileSync(bundledPath, JSON.stringify({ ...bundled, version }));
  await assertPackRefused('Bundled CLI release metadata is stale');
  writeFileSync(bundledPath, JSON.stringify(bundled));

  for (const entry of ['dist/index.js', 'dist/core.d.ts']) {
    const path = join(checkout, 'packages/core', entry);
    const contents = readFileSync(path);
    rmSync(path);
    await assertPackRefused(`Core entry point is missing (./${entry})`);
    writeFileSync(path, contents);
  }

  writeFileSync(join(checkout, 'packages/core/dist/.npmignore'), 'core.d.ts\n');
  await assertPackRefused("Core package would omit './dist/core.d.ts'");
}, 120_000);

it.skipIf(process.platform === 'win32')(
  'checks the tarball passed to npm by pnpm publish even when pack hooks are skipped',
  async () => {
    await assertPnpm('build');
    const cliTarball = join(checkout, 'cli.tgz');
    await assertPnpm('--filter', cliPackageName, 'pack', '--out', cliTarball);

    function dryRunPublish(pkg: 'core' | 'cli', ignoreScripts = true) {
      return runCommandAt(
        join(checkout, 'packages', pkg),
        'env',
        `npm_config_ignore_scripts=${String(ignoreScripts)}`,
        'npm_config_offline=true',
        'npm_config_loglevel=notice',
        'npm_config_registry=http://127.0.0.1:1',
        `npm_config_npm_path=${join(checkout, '.github/scripts/verify-npm-publish.mjs')}`,
        `AIPM_RELEASE_CLI_TARBALL=${cliTarball}`,
        'pnpm',
        'publish',
        '--dry-run',
        '--no-git-checks',
      );
    }

    for (const pkg of ['core', 'cli'] as const) {
      const valid = await dryRunPublish(pkg, false);
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout + valid.stderr).toContain('(dry-run)');
    }

    async function assertRejected(message: string, pkg: 'core' | 'cli' = 'core') {
      const rejected = await dryRunPublish(pkg);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(message);
      expect(rejected.stderr).not.toContain('(dry-run)');
    }

    const bundledPath = join(checkout, bundledManifest);
    const identity = readManifest(bundledManifest);
    const differentVersion = semver.inc(identity.version, 'major');
    rmSync(bundledPath);
    await assertRejected('package/dist/cli-release/package.json');
    writeFileSync(bundledPath, '{');
    await assertRejected('SyntaxError');
    writeFileSync(bundledPath, JSON.stringify({ ...identity, name: '@example/invalid-cli' }));
    await assertRejected('Invalid CLI release metadata');
    writeFileSync(bundledPath, JSON.stringify({ ...identity, version: differentVersion }));
    await assertRejected('Bundled CLI release metadata must contain only');
    writeFileSync(bundledPath, JSON.stringify({ ...identity, dependencies: {} }));
    await assertRejected('Bundled CLI release metadata must contain only');
    writeFileSync(bundledPath, JSON.stringify(identity));

    const dist = join(checkout, 'packages/core/dist');
    writeFileSync(join(dist, '.npmignore'), 'core.d.ts\n');
    expect(existsSync(join(dist, 'core.d.ts'))).toBe(true);
    await assertRejected('package/dist/core.d.ts');
    rmSync(join(dist, '.npmignore'));
    const runtimeEntry = join(dist, 'index.js');
    const runtime = readFileSync(runtimeEntry);
    rmSync(runtimeEntry);
    await assertRejected('package/dist/index.js');
    writeFileSync(runtimeEntry, runtime);

    const coreManifest = 'packages/core/package.json';
    const withoutTypes = JSON.parse(readFileSync(join(checkout, coreManifest), 'utf8')) as {
      types?: string;
    };
    delete withoutTypes.types;
    writeFileSync(join(checkout, coreManifest), JSON.stringify(withoutTypes));
    await assertRejected('Core must declare runtime and types entry points.');

    const cli = join(checkout, cliManifest);
    writeFileSync(cli, JSON.stringify({ ...readManifest(cliManifest), version: differentVersion }));
    await assertRejected('CLI publish tarball differs', 'cli');
  },
  120_000,
);

it('installs the packed core tarball and uses its runtime and type exports', async () => {
  await assertPnpm('build');
  await assertPnpm('--filter', corePackageName, 'pack', '--out', 'core.tgz');
  await assertPnpm('--filter', cliPackageName, 'pack', '--out', 'cli.tgz');
  const packedCli = await runCommand('tar', '-xOf', 'cli.tgz', 'package/package.json');
  expect(packedCli.status, packedCli.stderr).toBe(0);
  const publishedCli = JSON.parse(packedCli.stdout) as {
    name: string;
    version: string;
    dependencies: Record<string, string>;
  };
  expect(publishedCli.dependencies[corePackageName]).toBe(
    '^' + readManifest('packages/core/package.json').version,
  );

  const packedCoreIdentity = await runCommand(
    'tar',
    '-xOf',
    'core.tgz',
    'package/dist/cli-release/package.json',
  );
  expect(packedCoreIdentity.status, packedCoreIdentity.stderr).toBe(0);
  expect(JSON.parse(packedCoreIdentity.stdout)).toEqual({
    name: publishedCli.name,
    version: publishedCli.version,
  });

  const consumer = mkdtempSync(join(tmpdir(), 'aipm-packed-core-'));
  try {
    cpSync(join(checkout, 'core.tgz'), join(consumer, 'core.tgz'));
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [corePackageName]: 'file:./core.tgz' } }),
    );
    const install = await runPnpmAt(consumer, 'install', '--prefer-offline', '--ignore-scripts');
    expect(install.status, install.stdout + install.stderr).toBe(0);

    const runtime = await runCommandAt(
      consumer,
      process.execPath,
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
       import { createRequire } from 'node:module';
       import { init } from '${corePackageName}';
       await assert.rejects(import('${cliPackageName}'), { code: 'ERR_MODULE_NOT_FOUND' });
       const manifest = createRequire(import.meta.url)('${corePackageName}/package.json');
       assert.deepEqual(manifest.exports, {
         '.': { types: './dist/core.d.ts', import: './dist/index.js' },
         './package.json': './package.json',
       });
       await assert.rejects(import('${corePackageName}/init-cli'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
       await init('scaffold');`,
    );
    expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0);
    expect(readManifest('scaffold/package.json', consumer).devDependencies).toMatchObject({
      [cliPackageName]: `^${publishedCli.version}`,
      [corePackageName]: `^${readManifest('packages/core/package.json').version}`,
    });

    writeFileSync(
      join(consumer, 'consumer.mts'),
      `import { init, type InitOptions, type InitOutcome } from '${corePackageName}';
       const options: InitOptions = { name: 'consumer' };
       const outcome: InitOutcome = await init('scaffold', options);
       // @ts-expect-error cliVersion must be a string.
       await init('scaffold', { cliVersion: 123 });`,
    );
    const types = await runCommandAt(
      consumer,
      process.execPath,
      tsc,
      '--module',
      'nodenext',
      '--strict',
      '--noEmit',
      'consumer.mts',
    );
    expect(types.status, types.stdout + types.stderr).toBe(0);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}, 150_000);
