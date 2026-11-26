import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_REPO_CONFIG, hasRepoConfig, loadRepoConfig } from './load-config.js';
import type { ResolvedRepoConfig } from './load-config.js';

/**
 * Resolve a plugin path or a bare name from the current working directory. Existing directories
 * keep path precedence. Bare names are looked up under the configured plugins root.
 *
 * An explicit repo config takes precedence over the default layout: a nested pluginsRoot can
 * itself end in `plugins`. Without a config, bare names use the nearest default plugins layout
 * (or the working directory), and standalone paths retain the historical two-level layout.
 */
export async function resolvePluginArgument(
  argument: string,
): Promise<{ pluginDir: string; repoRoot: string; repoConfig: ResolvedRepoConfig }> {
  const cwd = process.cwd();
  const asPath = path.resolve(cwd, argument);
  const isName =
    argument === path.basename(argument) &&
    argument !== '' &&
    argument !== '.' &&
    argument !== '..' &&
    !fs.statSync(asPath, { throwIfNoEntry: false })?.isDirectory();

  const parent = path.dirname(asPath);
  let defaultRepoRoot: string | undefined;
  for (let dir = isName ? cwd : parent; ; dir = path.dirname(dir)) {
    if (hasRepoConfig(dir)) {
      const repoConfig = await loadRepoConfig(dir);
      const pluginDir = isName ? path.join(dir, repoConfig.pluginsRoot, argument) : asPath;
      return { pluginDir, repoRoot: dir, repoConfig };
    }
    if (isName && defaultRepoRoot === undefined) {
      const pluginsDir = path.join(dir, DEFAULT_REPO_CONFIG.pluginsRoot);
      if (fs.statSync(pluginsDir, { throwIfNoEntry: false })?.isDirectory()) {
        defaultRepoRoot = dir;
      }
    }

    if (path.dirname(dir) === dir) break;
  }

  const repoRoot = isName ? (defaultRepoRoot ?? cwd) : path.dirname(parent);
  const repoConfig = DEFAULT_REPO_CONFIG;
  const pluginDir = isName ? path.join(repoRoot, repoConfig.pluginsRoot, argument) : asPath;
  return { pluginDir, repoRoot, repoConfig };
}
