import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import semver from 'semver';
import { expect, it } from 'vitest';

const coreRoot = new URL('../../', import.meta.url);
const cliPackageName = '@ai-plugin-marketplace/cli';
const corePackageName = '@ai-plugin-marketplace/core';

function resolveDependencyDirectory(manifest: URL, dependency: string): string {
  const requireFromPackage = createRequire(manifest);
  for (const directory of requireFromPackage.resolve.paths(dependency) ?? []) {
    const candidate = join(directory, dependency);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Could not resolve ${dependency} from ${manifest.href}.`);
}

it('resolves dependencies installed at the workspace root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'aipm-init-hoisted-'));
  try {
    const manifest = pathToFileURL(join(workspace, 'packages', 'core', 'package.json'));
    const hoisted = join(workspace, 'node_modules', 'zod');
    mkdirSync(hoisted, { recursive: true });
    cpSync(
      join(resolveDependencyDirectory(new URL('package.json', coreRoot), 'zod'), 'package.json'),
      join(hoisted, 'package.json'),
    );
    expect(resolveDependencyDirectory(manifest, 'zod')).toBe(hoisted);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('scaffolds through the built public export with only core installed', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'aipm-init-dist-'));
  try {
    const installedCore = join(consumer, 'node_modules', corePackageName);
    const installedCoreDependencies = join(installedCore, 'node_modules');
    mkdirSync(installedCoreDependencies, { recursive: true });
    cpSync(new URL('dist', coreRoot), join(installedCore, 'dist'), { recursive: true });
    cpSync(new URL('package.json', coreRoot), join(installedCore, 'package.json'));
    const core = JSON.parse(readFileSync(join(installedCore, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    for (const dependency of Object.keys(core.dependencies)) {
      symlinkSync(
        resolveDependencyDirectory(new URL('package.json', coreRoot), dependency),
        join(installedCoreDependencies, dependency),
        'junction',
      );
    }

    execFileSync(
      process.execPath,
      [
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
      ],
      { cwd: consumer, stdio: 'pipe' },
    );
    const { devDependencies } = JSON.parse(
      readFileSync(join(consumer, 'scaffold', 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    const cli = JSON.parse(readFileSync(new URL('../cli/package.json', coreRoot), 'utf8')) as {
      version: string;
    };

    expect(devDependencies[cliPackageName]).toBe(`^${cli.version}`);
    expect(semver.satisfies(cli.version, devDependencies[cliPackageName] ?? '<0.0.0')).toBe(true);
    expect(devDependencies[corePackageName]).toBe(`^${core.version}`);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
