import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';
import { expect, it } from 'vitest';

const coreRoot = new URL('../../', import.meta.url);
const cliPackageName = '@ai-plugin-marketplace/cli';
const corePackageName = '@ai-plugin-marketplace/core';

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
        fileURLToPath(new URL(`node_modules/${dependency}`, coreRoot)),
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
         import { init } from '${corePackageName}';
         await assert.rejects(import('${cliPackageName}'), { code: 'ERR_MODULE_NOT_FOUND' });
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
