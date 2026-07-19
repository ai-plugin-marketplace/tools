/**
 * Public operation implementations.
 *
 * Each function here is a thin adapter over a pipeline orchestrator, with the pinned public
 * signature from §8.1 of the spec. Business logic lives in the orchestrators
 * (`build.ts`, `validate.ts`, `scaffold.ts`); this module only adapts arguments (e.g. deriving
 * the plugins directory from the cwd for `scaffold`, and reading the CI environment for the
 * freshness severity) so the public contract stays stable as implementations evolve.
 *
 * @see docs/specs/architecture.md §8.1
 */

import * as path from 'node:path';

import { runBuild } from './build.js';
import { runInit } from './init.js';
import { loadRepoConfig } from './load-config.js';
import { runRefreshScaffold } from './scaffold-refresh.js';
import { runScaffold, runAddTarget, runCheckSupport } from './scaffold.js';
import { TARGET_IDS } from './types.js';
import { runValidate } from './validate.js';
import type {
  AddTargetOutcome,
  BuildOptions,
  BuildResult,
  InitOptions,
  MigrateOptions,
  MigrateResult,
  RefreshOptions,
  RefreshOutcome,
  ScaffoldOptions,
  SupportReport,
  TargetId,
  ValidateOptions,
  ValidationResult,
} from './types.js';

/** True when running in a CI environment. Freshness findings are hard in CI, soft locally (§10.2). */
function isCi(): boolean {
  return Boolean(process.env['CI']);
}

/**
 * Build a single plugin or every plugin under a repo root. `path` may be a plugin directory
 * (contains `aipm.config.ts`) or a repo root (contains `plugins/`); the orchestrator detects
 * which and returns a length-1 array for single-plugin input. See §5.2, §8.1.
 *
 * @public
 */
export function build(targetPath: string, opts?: BuildOptions): Promise<BuildResult[]> {
  return runBuild(targetPath, opts);
}

/**
 * Validate a single plugin or every plugin under a repo root, in the order defined by §10.1.
 * Freshness severity follows the CI environment (§10.2).
 *
 * @public
 */
export function validate(targetPath: string, opts?: ValidateOptions): Promise<ValidationResult> {
  return runValidate(targetPath, { ...opts, ci: isCi() });
}

/**
 * Scaffold a thin consumer repo (the "template") at `targetDir` that depends on
 * `@ai-plugin-marketplace/cli` and holds plugin sources only (§3.2, §11). The generated
 * `package.json` pins the cli dev dependency to a caret of the current toolkit version (§9.1
 * lockstep). Refuses to write into a non-empty directory.
 *
 * @public
 */
export function init(targetDir: string, opts?: InitOptions): Promise<void> {
  return runInit(targetDir, opts);
}

/**
 * Refresh the toolkit-owned scaffold files (CI workflow, `.gitignore`) of an existing marketplace
 * repo at `targetDir` to match the installed tooling — the upgrade path after
 * `pnpm up @ai-plugin-marketplace/*`. Guarded by the `.aipm/scaffold.json` content-hash sidecar:
 * user-modified files are reported as conflicts and left untouched unless `opts.force` is set.
 * Returns one outcome per managed file; never rejects on conflict.
 *
 * @public
 */
export function refreshScaffold(
  targetDir: string,
  opts?: RefreshOptions,
): Promise<RefreshOutcome[]> {
  // Defer into the microtask queue so a synchronous failure in the orchestrator (e.g. an I/O error)
  // surfaces as a rejected promise — matching `refreshScaffold(...).catch(...)` expectations —
  // rather than throwing from this call before the promise exists.
  return Promise.resolve().then(() => runRefreshScaffold(targetDir, opts));
}

/**
 * Scaffold a new plugin under the cwd's configured plugins root (`<cwd>/plugins/<name>` by
 * default, or the relocated `pluginsRoot` from an `aipm.repo.ts`). The plugins directory is
 * derived from the current working directory, matching how `aipm scaffold` is invoked from a repo
 * root.
 *
 * @public
 */
export async function scaffold(name: string, opts: ScaffoldOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const repoConfig = await loadRepoConfig(cwd);
  const pluginsDir = path.join(cwd, repoConfig.pluginsRoot);
  return runScaffold(name, pluginsDir, opts);
}

/**
 * No-op in v0.1.0 per §8.1 of the spec. Always returns `status: 'no-migrations-needed'` because
 * §9.4 constrains every `schemaVersion` to a single value. When real migrations ship, this
 * must distinguish up-to-date from unknown-future-version.
 *
 * @public
 */
export function migrate(_path: string, _opts?: MigrateOptions): Promise<MigrateResult> {
  return Promise.resolve({
    status: 'no-migrations-needed',
    migrationsApplied: 0,
    filesChanged: [],
  });
}

/**
 * Diagnose a plugin's support envelope: declared targets, missing artifacts, addable targets (§6.4).
 *
 * @public
 */
export function checkSupport(pluginDir: string): Promise<SupportReport> {
  return runCheckSupport(pluginDir);
}

/**
 * Scaffold skeleton files for a new target in an existing plugin (§6.4). Preserve-or-warn, never
 * destructive: an already-materialized target (every file it would write already exists) is a
 * friendly no-op (`status: 'already-present'`) rather than a thrown error, and existing files are
 * never overwritten — see {@link AddTargetOutcome}.
 *
 * @public
 */
export function addTarget(pluginDir: string, target: TargetId): Promise<AddTargetOutcome> {
  return runAddTarget(pluginDir, target);
}

/**
 * List the target IDs this toolkit version knows about (§6.4).
 *
 * @public
 */
export function listTargets(): readonly TargetId[] {
  return TARGET_IDS;
}
