import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_REPO_CONFIG, hasRepoConfig, loadRepoConfig } from './load-config.js';

export interface RepoLayout {
  repoRoot: string;
  pluginsDir: string;
  distDir: string;
}

/** Resolve existing path components, including those above a yet-to-be-created directory. */
function canonicalPath(absolutePath: string): string {
  if (fs.lstatSync(absolutePath, { throwIfNoEntry: false }) !== undefined) {
    return fs.realpathSync(absolutePath);
  }

  return path.join(canonicalPath(path.dirname(absolutePath)), path.basename(absolutePath));
}

export function isDirectory(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Configured roots can link to another directory within the repo. */
export async function readRepoLayout(repoRoot: string): Promise<RepoLayout> {
  const config = await loadRepoConfig(repoRoot);
  const pluginsDir = canonicalPath(path.join(repoRoot, config.pluginsRoot));
  const relative = path.relative(repoRoot, pluginsDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`pluginsRoot '${config.pluginsRoot}' resolves outside the repo '${repoRoot}'.`);
  }
  return { repoRoot, pluginsDir, distDir: path.join(repoRoot, config.distDir) };
}

/** Find the nearest configured or default layout above cwd, falling back to cwd for a new repo. */
export async function findRepoLayout(cwd: string): Promise<RepoLayout> {
  const start = canonicalPath(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (hasRepoConfig(dir) || isDirectory(path.join(dir, DEFAULT_REPO_CONFIG.pluginsRoot))) {
      return readRepoLayout(dir);
    }
    if (path.dirname(dir) === dir) return readRepoLayout(start);
  }
}

/** Locate the candidate without loading a repo config for an explicit directory path. */
export async function resolvePluginPath(argument: string, lookupByName = false): Promise<string> {
  const cwd = process.cwd();
  const asPath = path.resolve(cwd, argument);
  if (
    lookupByName &&
    argument === path.basename(argument) &&
    argument !== '' &&
    argument !== '.' &&
    argument !== '..' &&
    !isDirectory(asPath)
  ) {
    const { pluginsDir } = await findRepoLayout(cwd);
    return canonicalPath(path.join(pluginsDir, argument));
  }
  return canonicalPath(asPath);
}

/**
 * Find the owner of a canonical plugin path. A repo only declares ownership of immediate children
 * of its plugins root. Explicit layouts take precedence when they declare the same directory as
 * an implicit default layout, so a nested configured path ending in "plugins" keeps its owner.
 */
export async function findDeclaredPluginOwner(
  pluginDir: string,
  knownLayout?: RepoLayout,
): Promise<RepoLayout | undefined> {
  const parent = path.dirname(pluginDir);
  let defaultLayout: RepoLayout | undefined;
  for (let dir = parent; ; dir = path.dirname(dir)) {
    if (hasRepoConfig(dir)) {
      const layout = knownLayout?.repoRoot === dir ? knownLayout : await readRepoLayout(dir);
      if (layout.pluginsDir === parent) return layout;
    } else if (defaultLayout === undefined) {
      const defaultPluginsDir = path.join(dir, DEFAULT_REPO_CONFIG.pluginsRoot);
      if (isDirectory(defaultPluginsDir) && canonicalPath(defaultPluginsDir) === parent) {
        defaultLayout = {
          repoRoot: dir,
          pluginsDir: parent,
          distDir: path.join(dir, DEFAULT_REPO_CONFIG.distDir),
        };
      }
    }
    if (path.dirname(dir) === dir) break;
  }
  return defaultLayout;
}

export async function findPluginOwner(
  pluginDir: string,
  knownLayout?: RepoLayout,
): Promise<RepoLayout> {
  const layout = await findDeclaredPluginOwner(pluginDir, knownLayout);
  if (layout !== undefined) return layout;

  const standaloneRoot = path.dirname(path.dirname(pluginDir));
  if (hasRepoConfig(standaloneRoot)) {
    throw new Error(
      `Plugin '${pluginDir}' is outside the configured pluginsRoot of '${standaloneRoot}'.`,
    );
  }
  // Preserve the historical two-level layout for standalone plugin paths.
  return {
    repoRoot: standaloneRoot,
    pluginsDir: path.join(standaloneRoot, DEFAULT_REPO_CONFIG.pluginsRoot),
    distDir: path.join(standaloneRoot, DEFAULT_REPO_CONFIG.distDir),
  };
}
