/**
 * Plugin discovery: resolve a `targetPath` (plugin dir or repo root) to the list of plugin
 * directories to operate on plus the `dist/` output root. Shared by the build (§5.2) and
 * validate (§5.3) orchestrators so they detect topology identically.
 *
 * Detection rules (§8.1 "Why one build signature"):
 * - **Repo root** — `targetPath` contains a `plugins/` directory. Every immediate subdirectory
 *   of `plugins/` that contains an `aipm.config.ts` is a plugin; `dist/` sits at `<root>/dist`.
 * - **Single plugin** — otherwise `targetPath` is treated as a single plugin directory. The repo
 *   root is the plugin's grandparent (`repoRoot = dirname(dirname(pluginDir))`) and `dist/` sits
 *   there. A missing `aipm.config.ts` is **not** a discovery error: it is deferred to the
 *   config loader so the validate orchestrator can report it as an `envelope-invalid` finding
 *   (§10.1 step 1) and the build orchestrator can throw a descriptive error.
 *
 * Repo-root detection is tried first so a real repo root is never misread as a single plugin.
 *
 * @see docs/specs/architecture.md §8.1, §3.2 (repository topology), §10.1 (validation order)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AIPM_CONFIG_FILENAME } from './load-config.js';

/** Result of resolving a `targetPath` to concrete plugin directories and a dist root. */
export interface Discovery {
  /** Absolute repo root (where `dist/` lives). */
  repoRoot: string;
  /** Absolute `dist/` output directory. */
  distDir: string;
  /** Absolute plugin directories to operate on (length 1 for single-plugin input). */
  pluginDirs: string[];
}

/** True iff `dir` contains an `aipm.config.ts`. */
function hasConfig(dir: string): boolean {
  return fs.existsSync(path.join(dir, AIPM_CONFIG_FILENAME));
}

/**
 * Resolve `targetPath` to the plugins to build/validate and the `dist/` root.
 *
 * @param targetPath - Absolute path to a single plugin directory or a repo root.
 * @returns The resolved discovery.
 * @throws {Error} If `targetPath` is neither a plugin directory nor a repo root with a
 *   `plugins/` directory.
 */
export function discoverPlugins(targetPath: string): Discovery {
  const resolved = path.resolve(targetPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path '${targetPath}' does not exist.`);
  }

  // ── Repo-root input (tried first) ─────────────────────────────────────────
  // A path is a repo root when it does NOT itself carry a config but does contain a `plugins/`
  // directory. (A plugin directory that happens to contain a `plugins/` subfolder is vanishingly
  // unlikely and would be a layout error; carrying its own config disambiguates it as a plugin.)
  const pluginsDir = path.join(resolved, 'plugins');
  if (!hasConfig(resolved) && fs.existsSync(pluginsDir) && fs.statSync(pluginsDir).isDirectory()) {
    const pluginDirs: string[] = [];
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(pluginsDir, entry.name);
      if (hasConfig(candidate)) {
        pluginDirs.push(candidate);
      }
    }
    pluginDirs.sort();
    return {
      repoRoot: resolved,
      distDir: path.join(resolved, 'dist'),
      pluginDirs,
    };
  }

  // ── Single-plugin input ───────────────────────────────────────────────────
  // Whether or not it carries a config: a missing config is deferred to the loader so validate
  // can emit `envelope-invalid` and build can throw a descriptive error (§10.1 step 1).
  const grandparent = path.dirname(path.dirname(resolved));
  return {
    repoRoot: grandparent,
    distDir: path.join(grandparent, 'dist'),
    pluginDirs: [resolved],
  };
}
