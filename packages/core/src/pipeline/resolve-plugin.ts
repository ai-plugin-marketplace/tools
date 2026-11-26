import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ConfigLoadError,
  DEFAULT_REPO_CONFIG,
  hasRepoConfig,
  loadRepoConfig,
} from './load-config.js';
import type { ResolvedRepoConfig } from './load-config.js';

export interface RepoLayout {
  repoRoot: string;
  pluginsDir: string;
  pluginsPath: string;
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

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function* ancestors(start: string): Generator<string> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    yield dir;
    // Git worktrees and submodules use a file in place of the usual .git directory.
    if (path.dirname(dir) === dir || fs.existsSync(path.join(dir, '.git'))) return;
  }
}

/** Configured roots can link to another directory within the repo. */
export async function readRepoLayout(root: string): Promise<RepoLayout> {
  const repoRoot = canonicalPath(root);
  return resolveRepoLayout(repoRoot, await loadRepoConfig(repoRoot));
}

function resolveRepoLayout(repoRoot: string, config: ResolvedRepoConfig): RepoLayout {
  const pluginsPath = path.join(repoRoot, config.pluginsRoot);
  const pluginsDir = canonicalPath(pluginsPath);
  if (!isWithin(repoRoot, pluginsDir)) {
    throw new ConfigLoadError(
      `pluginsRoot '${config.pluginsRoot}' resolves outside the repo '${repoRoot}'.`,
    );
  }
  return { repoRoot, pluginsDir, pluginsPath, distDir: path.join(repoRoot, config.distDir) };
}

/** Find the nearest layout above cwd, stopping at the checkout boundary. */
export async function findRepoLayout(cwd: string): Promise<RepoLayout> {
  const start = canonicalPath(cwd);
  for (const dir of ancestors(start)) {
    if (hasRepoConfig(dir) || isDirectory(path.join(dir, DEFAULT_REPO_CONFIG.pluginsRoot))) {
      return readRepoLayout(dir);
    }
    if (fs.existsSync(path.join(dir, '.git'))) return readRepoLayout(dir);
  }
  return readRepoLayout(start);
}

function singleComponent(argument: string): string | undefined {
  if (path.isAbsolute(argument) || path.parse(argument).root !== '') return undefined;
  const parts = argument.split(path.sep === '\\' ? /[/\\]/ : /\//).filter(Boolean);
  if (parts[0] === '.') parts.shift();
  const [name] = parts;
  return parts.length === 1 && name !== '.' && name !== '..' ? name : undefined;
}

/** Resolve a CLI name or explicit path, retaining the lexical route for containment checks. */
export async function resolvePluginPath(
  argument: string,
  lookupByName = false,
): Promise<{ pluginDir: string; routedLayout?: RepoLayout }> {
  const cwd = process.cwd();
  let lexical = path.resolve(cwd, argument);
  const name = lookupByName ? singleComponent(argument) : undefined;
  if (name !== undefined) {
    const exists = isDirectory(lexical);
    let layout: RepoLayout | undefined;
    try {
      layout = await findRepoLayout(cwd);
    } catch (error) {
      if (!exists || !(error instanceof ConfigLoadError)) throw error;
    }
    if (layout !== undefined) {
      const namedPath = path.join(layout.pluginsPath, name);
      if (
        !exists ||
        (isDirectory(namedPath) && isWithin(canonicalPath(layout.distDir), canonicalPath(lexical)))
      ) {
        lexical = namedPath;
      }
    }
  }

  const pluginDir = canonicalPath(lexical);
  if (pluginDir === lexical) return { pluginDir };

  // An explicit path may reach a plugin through a configured symlink. Check that route
  // before the ownership walk follows the physical path, which may be in a different repo.
  let routedLayout: RepoLayout | undefined;
  for (const dir of ancestors(path.dirname(lexical))) {
    let config;
    try {
      config = await loadRepoConfig(dir);
    } catch (error) {
      if (!(error instanceof ConfigLoadError)) throw error;
      continue;
    }
    if (!isWithin(path.join(dir, config.pluginsRoot), lexical)) continue;

    const layout = resolveRepoLayout(canonicalPath(dir), config);
    if (hasRepoConfig(dir) && !isWithin(layout.repoRoot, pluginDir)) {
      throw new ConfigLoadError(`Plugin '${lexical}' resolves outside the repo '${dir}'.`);
    }
    if (routedLayout === undefined && layout.pluginsDir === path.dirname(pluginDir)) {
      routedLayout = layout;
    }
  }
  return routedLayout === undefined ? { pluginDir } : { pluginDir, routedLayout };
}

/**
 * Find the owner of a physical plugin path. A configured layout takes precedence over a
 * nearer default layout only when both claim the same plugins directory.
 */
export async function findDeclaredPluginOwner(
  pluginDir: string,
  searchAncestors: boolean,
  knownLayout?: RepoLayout,
): Promise<RepoLayout | undefined> {
  const parent = path.dirname(pluginDir);
  const grandparent = path.dirname(parent);
  let defaultLayout: RepoLayout | undefined;
  let fallbackError: ConfigLoadError | undefined;
  const lastDir =
    knownLayout !== undefined && isWithin(knownLayout.repoRoot, grandparent)
      ? knownLayout.repoRoot
      : grandparent;
  for (const dir of ancestors(parent)) {
    if (hasRepoConfig(dir)) {
      try {
        const layout = knownLayout?.repoRoot === dir ? knownLayout : await readRepoLayout(dir);
        if (layout.pluginsDir === parent) return layout;
      } catch (error) {
        if (!(error instanceof ConfigLoadError)) throw error;
        if (dir === grandparent) fallbackError = error;
      }
    } else if (defaultLayout === undefined) {
      const pluginsPath = path.join(dir, DEFAULT_REPO_CONFIG.pluginsRoot);
      if (isDirectory(pluginsPath) && canonicalPath(pluginsPath) === parent) {
        defaultLayout = {
          repoRoot: dir,
          pluginsDir: parent,
          pluginsPath,
          distDir: path.join(dir, DEFAULT_REPO_CONFIG.distDir),
        };
      }
    }
    if (!searchAncestors && dir === lastDir) break;
  }
  if (defaultLayout === undefined && fallbackError !== undefined) throw fallbackError;
  return defaultLayout;
}

export async function findPluginOwner(
  pluginDir: string,
  searchAncestors: boolean,
  knownLayout?: RepoLayout,
): Promise<RepoLayout> {
  const layout = await findDeclaredPluginOwner(pluginDir, searchAncestors, knownLayout);
  if (layout !== undefined) return layout;

  // Preserve the historical two-level layout for standalone plugin paths.
  const parent = path.dirname(pluginDir);
  return readRepoLayout(fs.existsSync(path.join(parent, '.git')) ? parent : path.dirname(parent));
}

/** Use the configured route for registry entries for plugins belonging to this layout. */
export function registryPluginPath(layout: RepoLayout, pluginDir: string): string {
  return path.dirname(pluginDir) === layout.pluginsDir
    ? path.join(layout.pluginsPath, path.basename(pluginDir))
    : pluginDir;
}
