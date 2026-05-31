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
import { runScaffold, runAddTarget, runCheckSupport } from './scaffold.js';
import { TARGET_IDS } from './types.js';
import { runValidate } from './validate.js';
import type {
  BuildOptions,
  BuildResult,
  MigrateOptions,
  MigrateResult,
  ScaffoldOptions,
  SupportReport,
  TargetId,
  ValidateOptions,
  ValidationResult,
} from './types.js';

/** True when running in a CI environment. Freshness findings are hard in CI, soft locally (§10.2). */
function isCi(): boolean {
  return Boolean(process.env.CI);
}

/**
 * Build a single plugin or every plugin under a repo root. `path` may be a plugin directory
 * (contains `aipm.config.ts`) or a repo root (contains `plugins/`); the orchestrator detects
 * which and returns a length-1 array for single-plugin input. See §5.2, §8.1.
 */
export function build(targetPath: string, opts?: BuildOptions): Promise<BuildResult[]> {
  return runBuild(targetPath, opts);
}

/**
 * Validate a single plugin or every plugin under a repo root, in the order defined by §10.1.
 * Freshness severity follows the CI environment (§10.2).
 */
export function validate(targetPath: string, opts?: ValidateOptions): Promise<ValidationResult> {
  return runValidate(targetPath, { ...opts, ci: isCi() });
}

/**
 * Scaffold a new plugin under `<cwd>/plugins/<name>`. The plugins directory is derived from the
 * current working directory, matching how `aipm scaffold` is invoked from a template repo root.
 */
export function scaffold(name: string, opts: ScaffoldOptions = {}): Promise<void> {
  const pluginsDir = path.join(process.cwd(), 'plugins');
  return runScaffold(name, pluginsDir, opts);
}

/**
 * No-op in v0.1.0 per §8.1 of the spec. Always returns `status: 'no-migrations-needed'` because
 * §9.4 constrains every `schemaVersion` to a single value. When real migrations ship, this
 * must distinguish up-to-date from unknown-future-version.
 */
export function migrate(_path: string, _opts?: MigrateOptions): Promise<MigrateResult> {
  return Promise.resolve({
    status: 'no-migrations-needed',
    migrationsApplied: 0,
    filesChanged: [],
  });
}

/** Diagnose a plugin's support envelope: declared targets, missing artifacts, addable targets (§6.4). */
export function checkSupport(pluginDir: string): Promise<SupportReport> {
  return runCheckSupport(pluginDir);
}

/** Scaffold skeleton files for a new target in an existing plugin (§6.4). */
export function addTarget(pluginDir: string, target: TargetId): Promise<void> {
  return runAddTarget(pluginDir, target);
}

/** List the target IDs this toolkit version knows about (§6.4). */
export function listTargets(): readonly TargetId[] {
  return TARGET_IDS;
}
