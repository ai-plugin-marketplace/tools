import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { InitOptions, InitOutcome } from '@ai-plugin-marketplace/core';

export async function initFromCli(
  dir: string,
  cliPackageJson: URL,
  opts: Pick<InitOptions, 'name' | 'marketplaceName'>,
): Promise<InitOutcome> {
  // Resolve from CLI's installed dependency so this works in both npm and pnpm layouts.
  // The scaffolder is shared with core's public init via an internal module.
  const coreManifest = createRequire(import.meta.url).resolve(
    '@ai-plugin-marketplace/core/package.json',
  );
  const coreInit = new URL('./dist/pipeline/init.js', pathToFileURL(coreManifest));
  const { runInit } = (await import(
    coreInit.href
  )) as typeof import('../../core/src/pipeline/init.js');
  return runInit(dir, opts, cliPackageJson);
}
