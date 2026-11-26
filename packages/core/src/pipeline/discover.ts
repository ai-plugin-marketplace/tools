/**
 * Plugin discovery: resolve a `targetPath` (plugin dir or repo root) to the list of plugin
 * directories to operate on plus the dist output root. Shared by the build (§5.2) and
 * validate (§5.3) orchestrators so they detect topology identically.
 *
 * Detection rules (§8.1 "Why one build signature"):
 * - **Repo root** — `targetPath` contains the configured plugins root (default `plugins/`), or an
 *   `aipm.repo.ts`. Every immediate subdirectory of the plugins root that either contains an
 *   `aipm.config.ts` OR is otherwise **plugin-shaped** (see {@link isPluginShaped}) is a plugin;
 *   generated bundles sit at the configured dist root (default `<root>/dist`). A plugin-shaped
 *   subdirectory missing `aipm.config.ts` is deliberately still included — see below — so it is
 *   never silently dropped from discovery (#91). A subdirectory with NEITHER a config NOR any
 *   plugin-shape marker is not a plugin at all and stays excluded (unchanged non-goal).
 * - **Single plugin** — otherwise `targetPath` is treated as a single plugin directory. The repo
 *   root and dist root come from the owning repo config. A bare plugin name is resolved under
 *   the configured plugins root. A missing `aipm.config.ts` is **not** a discovery
 *   error: it is deferred to the config loader so the validate orchestrator can report it as an
 *   `envelope-invalid` finding (§10.1 step 1) and the build orchestrator can throw a descriptive
 *   error.
 *
 * **Plugin-shaped-but-configless directories (#91).** Before this fix, a `plugins/*` subdirectory
 * that carried target manifests and/or skills but no `aipm.config.ts` was filtered out of
 * `pluginDirs` entirely — `aipm validate`/`aipm build` never saw it, so both silently reported
 * success (`validate` green, `build` "Built 0 plugin(s)") even though the directory was a broken,
 * unbuildable plugin. Now such a directory is included in `pluginDirs` like any other candidate;
 * the deferred-to-the-loader missing-config handling above then reports it exactly like a
 * single-plugin target missing its config would: `envelope-invalid` from validate, a thrown
 * `ConfigLoadError` from build.
 *
 * A plugin-shaped child of its owning plugins root takes precedence over an implicit repo layout.
 *
 * The plugins root and dist root are read from an optional `aipm.repo.ts` at the repo root
 * (embedded-marketplace support). Absent that file, they default to `plugins/` and `dist/`, so a
 * repo with no repo config behaves exactly as before.
 *
 * @see docs/specs/architecture.md §8.1, §3.2 (repository topology), §10.1 (validation order)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AIPM_CONFIG_FILENAME, DEFAULT_REPO_CONFIG, hasRepoConfig } from './load-config.js';
import {
  findDeclaredPluginOwner,
  findPluginOwner,
  isDirectory,
  readRepoLayout,
  resolvePluginPath,
} from './resolve-plugin.js';

/** Result of resolving a `targetPath` to concrete plugin directories and a dist root. */
export interface Discovery {
  /** Whether the argument selected the whole repo. */
  isRepoRoot: boolean;
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

/**
 * Target-manifest markers whose presence identifies a directory as plugin-shaped even without
 * `aipm.config.ts`. One entry per target's minimum-required manifest — mirrors `validate.ts`'s
 * `TARGET_MIN_REQUIRED` (§10.1). Intentionally kept as an independent list here rather than
 * imported from `validate.ts`, which itself imports `discoverPlugins` from this module — importing
 * back would create a module cycle. `vercel` has no manifest of its own (its shape marker is a
 * skill; see {@link hasSkills}), so it is not listed here.
 */
const PLUGIN_SHAPE_MANIFESTS = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'gemini-extension.json',
  'POWER.md',
  '.plugin/plugin.json',
];

/**
 * True iff `dir` contains at least one `skills/<name>/SKILL.md`. This is the Vercel target's shape
 * marker (Vercel has no manifest file of its own — a skill IS the artifact), and doubles as a
 * general "this directory has authored plugin content" signal for targets that ship skills
 * alongside a manifest.
 */
function hasSkills(dir: string): boolean {
  const skillsDir = path.join(dir, 'skills');
  if (!isDirectory(skillsDir)) return false;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
      return true;
    }
  }
  return false;
}

/**
 * True iff `dir` carries any target-manifest marker or a skill — i.e. it looks like an authored
 * plugin even though it may be missing `aipm.config.ts`. Distinguishes "broken plugin" (include in
 * discovery so validate/build can report it, #91) from "not a plugin at all" (silently excluded,
 * unchanged non-goal — an empty or unrelated directory under `plugins/` stays ignored).
 */
function isPluginShaped(dir: string): boolean {
  return PLUGIN_SHAPE_MANIFESTS.some((rel) => fs.existsSync(path.join(dir, rel))) || hasSkills(dir);
}

/**
 * Resolve `targetPath` to the plugins to build/validate and the dist root.
 *
 * @param targetPath - A repo path, plugin directory path, or bare plugin name.
 * @returns The resolved discovery.
 * @throws {Error} If `targetPath` does not exist.
 * @throws {ConfigLoadError} If a present `aipm.repo.ts` cannot be imported or fails validation.
 */
export async function discoverPlugins(targetPath: string): Promise<Discovery> {
  const pluginDir = await resolvePluginPath(targetPath, true);
  if (!isDirectory(pluginDir)) {
    throw new Error(`Path '${targetPath}' does not exist.`);
  }

  const hasPluginConfig = hasConfig(pluginDir);
  const hasExplicitLayout = !hasPluginConfig && hasRepoConfig(pluginDir);
  const hasDefaultLayout =
    !hasPluginConfig &&
    !hasExplicitLayout &&
    isDirectory(path.join(pluginDir, DEFAULT_REPO_CONFIG.pluginsRoot));
  const owner =
    hasDefaultLayout && isPluginShaped(pluginDir)
      ? await findDeclaredPluginOwner(pluginDir)
      : undefined;

  if (hasExplicitLayout || (hasDefaultLayout && owner === undefined)) {
    const layout = await readRepoLayout(pluginDir);
    const { repoRoot, pluginsDir, distDir } = layout;
    const pluginDirs: string[] = [];
    if (isDirectory(pluginsDir)) {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(pluginsDir, entry.name);
        if (
          (hasConfig(candidate) || isPluginShaped(candidate)) &&
          (await findDeclaredPluginOwner(candidate, layout))?.repoRoot === repoRoot
        ) {
          pluginDirs.push(candidate);
        }
      }
      pluginDirs.sort();
    }
    return { isRepoRoot: true, repoRoot, distDir, pluginDirs };
  }

  // Missing plugin configs are deferred to build/validate so they can report an envelope error.
  const { repoRoot, distDir } = owner ?? (await findPluginOwner(pluginDir));
  return { isRepoRoot: false, repoRoot, distDir, pluginDirs: [pluginDir] };
}
