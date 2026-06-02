/**
 * Plugin discovery: resolve a `targetPath` (plugin dir or repo root) to the list of plugin
 * directories to operate on plus the dist output root. Shared by the build (§5.2) and
 * validate (§5.3) orchestrators so they detect topology identically.
 *
 * Detection rules (§8.1 "Why one build signature"):
 * - **Repo root** — `targetPath` contains the configured plugins root (default `plugins/`), or an
 *   `aipm.repo.ts`. Every immediate subdirectory of the plugins root that contains an
 *   `aipm.config.ts` is a plugin; generated bundles sit at the configured dist root
 *   (default `<root>/dist`).
 * - **Single plugin** — otherwise `targetPath` is treated as a single plugin directory. The repo
 *   root is the plugin's grandparent (`repoRoot = dirname(dirname(pluginDir))`) and the dist root
 *   is resolved from that repo root's config. A missing `aipm.config.ts` is **not** a discovery
 *   error: it is deferred to the config loader so the validate orchestrator can report it as an
 *   `envelope-invalid` finding (§10.1 step 1) and the build orchestrator can throw a descriptive
 *   error.
 *
 * Repo-root detection is tried first so a real repo root is never misread as a single plugin.
 *
 * The plugins root and dist root are read from an optional `aipm.repo.ts` at the repo root
 * (embedded-marketplace support). Absent that file, they default to `plugins/` and `dist/`, so a
 * repo with no repo config behaves exactly as before.
 *
 * @see docs/specs/architecture.md §8.1, §3.2 (repository topology), §10.1 (validation order)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AIPM_CONFIG_FILENAME, hasRepoConfig, loadRepoConfig } from './load-config.js';

/** Result of resolving a `targetPath` to concrete plugin directories and a dist root. */
export interface Discovery {
  /** Absolute repo root (where the configured plugins/dist roots live). */
  repoRoot: string;
  /** Absolute dist output directory (the configured dist root under the repo root). */
  distDir: string;
  /** Absolute plugin directories to operate on (length 1 for single-plugin input). */
  pluginDirs: string[];
}

/** True iff `dir` contains an `aipm.config.ts`. */
function hasConfig(dir: string): boolean {
  return fs.existsSync(path.join(dir, AIPM_CONFIG_FILENAME));
}

/** True iff `dir` exists and is a directory. */
function isDirectory(dir: string): boolean {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

/**
 * Resolve `targetPath` to the plugins to build/validate and the dist root.
 *
 * @param targetPath - Absolute path to a single plugin directory or a repo root.
 * @returns The resolved discovery.
 * @throws {Error} If `targetPath` does not exist.
 * @throws {ConfigLoadError} If a present `aipm.repo.ts` cannot be imported or fails validation.
 */
export async function discoverPlugins(targetPath: string): Promise<Discovery> {
  const resolved = path.resolve(targetPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path '${targetPath}' does not exist.`);
  }

  // ── Repo-root input (tried first) ─────────────────────────────────────────
  // A path is a repo root when it does NOT itself carry a plugin config but either declares an
  // `aipm.repo.ts` or contains the configured plugins root. (A plugin directory that happens to
  // contain a `plugins/` subfolder is vanishingly unlikely and would be a layout error; carrying
  // its own `aipm.config.ts` disambiguates it as a plugin.)
  if (!hasConfig(resolved)) {
    const repoConfig = await loadRepoConfig(resolved);
    const pluginsDir = path.join(resolved, repoConfig.pluginsRoot);
    // An explicit `aipm.repo.ts` marks a repo root even before its plugins dir exists, so a
    // freshly-initialised embedded repo still resolves as a repo root rather than a single plugin.
    if (hasRepoConfig(resolved) || isDirectory(pluginsDir)) {
      const pluginDirs: string[] = [];
      if (isDirectory(pluginsDir)) {
        for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(pluginsDir, entry.name);
          if (hasConfig(candidate)) {
            pluginDirs.push(candidate);
          }
        }
        pluginDirs.sort();
      }
      return {
        repoRoot: resolved,
        distDir: path.join(resolved, repoConfig.distDir),
        pluginDirs,
      };
    }
  }

  // ── Single-plugin input ───────────────────────────────────────────────────
  // Whether or not it carries a config: a missing config is deferred to the loader so validate
  // can emit `envelope-invalid` and build can throw a descriptive error (§10.1 step 1). The dist
  // root is resolved from the repo root's config so a relocated dist root is still honored.
  const grandparent = path.dirname(path.dirname(resolved));
  const repoConfig = await loadRepoConfig(grandparent);
  return {
    repoRoot: grandparent,
    distDir: path.join(grandparent, repoConfig.distDir),
    pluginDirs: [resolved],
  };
}
