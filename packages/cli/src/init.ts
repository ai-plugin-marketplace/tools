import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { init } from '@ai-plugin-marketplace/core';
import type { InitOptions, InitOutcome } from '@ai-plugin-marketplace/core';
import semver from 'semver';

const CLI_PACKAGE_NAME = '@ai-plugin-marketplace/cli';

export async function initFromCli(
  dir: string,
  cliPackageJson: URL,
  opts: Pick<InitOptions, 'name' | 'marketplaceName'>,
): Promise<InitOutcome> {
  const cli = JSON.parse(readFileSync(cliPackageJson, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  } | null;
  const version =
    cli?.name === CLI_PACKAGE_NAME && typeof cli.version === 'string'
      ? semver.valid(cli.version)
      : null;
  if (version === null || !semver.satisfies(version, `^${version}`)) {
    throw new Error(
      `Invalid CLI release metadata in '${cliPackageJson.href}': expected ${CLI_PACKAGE_NAME}.`,
    );
  }

  const outcome = await init(dir, opts);
  const manifestPath = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const range = `^${version}`;
  if (manifest.devDependencies[CLI_PACKAGE_NAME] === range) return outcome;

  manifest.devDependencies[CLI_PACKAGE_NAME] = range;
  const temporary = mkdtempSync(join(dir, '.aipm-init-'));
  try {
    const replacement = join(temporary, 'package.json');
    writeFileSync(replacement, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(replacement, manifestPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return outcome;
}
