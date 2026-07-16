/**
 * Runtime loader for a plugin's `aipm.config.ts` envelope (§6.1, P6).
 *
 * `aipm.config.ts` is authored in TypeScript and imports `defineConfig` from
 * `@ai-plugin-marketplace/core`. The build (§5.2) and validate (§5.3) orchestrators need to
 * evaluate that module at runtime to read its `default` export. We use {@link https://github.com/unjs/jiti | jiti}
 * to transpile-and-import the TS module on the fly, then re-run it through {@link defineConfig}
 * so the result is a properly-branded {@link AipmConfig} regardless of what the on-disk module
 * happened to call.
 *
 * **Module resolution.** A plugin's `aipm.config.ts` can live anywhere on disk (including a
 * temp dir during tests), so a bare `import '@ai-plugin-marketplace/core'` would not resolve
 * by walking up from the config file. We register a jiti `alias` mapping the package specifier
 * to this package's own entrypoint, derived from {@link import.meta.url}. The alias is
 * extension-less so jiti resolves `index.ts` when running from source (vitest) and `index.js`
 * when running from the compiled `dist/` (production) — both verified working.
 *
 * @see docs/specs/architecture.md §6.1 (envelope declaration), P6 (TypeScript end-to-end)
 * @see docs/specs/architecture.md §5.2, §5.3 (build/validate consume the loaded envelope)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJiti } from 'jiti';

import { defineConfig, defineRepoConfig, defineWorkspace } from '../config.js';
import type {
  AipmConfig,
  AipmConfigInput,
  AipmRepoConfigInput,
  AipmWorkspace,
  AipmWorkspaceInput,
} from '../config.js';

/** The canonical config filename every plugin must provide (§6.1). */
export const AIPM_CONFIG_FILENAME = 'aipm.config.ts';

/**
 * Optional repo-level config filename. When present at a repo root it relocates the plugins/dist
 * roots (embedded-marketplace support); when absent the toolkit uses the historical defaults.
 * Module-private — callers use {@link hasRepoConfig}/{@link loadRepoConfig} rather than the name.
 */
const AIPM_REPO_CONFIG_FILENAME = 'aipm.repo.ts';

/**
 * Optional workspace-level config filename. Its presence at a repo root opts the repo into
 * marketplace-registry generation; absence preserves the historical hand-authored-registry
 * behavior. Module-private — callers use {@link hasWorkspaceConfig}/{@link loadWorkspaceConfig}
 * rather than the name (mirrors {@link AIPM_REPO_CONFIG_FILENAME}).
 */
const AIPM_WORKSPACE_CONFIG_FILENAME = 'aipm.workspace.ts';

/** The npm specifier a plugin's `aipm.config.ts` imports `defineConfig` from. */
const CORE_PACKAGE_SPECIFIER = '@ai-plugin-marketplace/core';

/**
 * Error thrown when a plugin's `aipm.config.ts` cannot be located, imported, or validated.
 * The build orchestrator surfaces this as a thrown error; the validate orchestrator catches it
 * and converts it into an `envelope-invalid` finding (§10.1 step 1).
 */
export class ConfigLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigLoadError';
  }
}

/**
 * Absolute path (extension-less) that the config-file `import '@ai-plugin-marketplace/core'`
 * specifier is aliased to when jiti loads a config. Resolves to `<src|dist>/config`, derived from
 * this module's location; jiti's resolver appends `.ts` from source (vitest) or `.js` from the
 * compiled `dist/` (production).
 *
 * **Why `config`, not `index`.** Config files only import the `define*` functions, which all live
 * in `config.ts` (whose only deps are `zod` + the tiny `types.ts`). Aliasing to the package
 * `index` would instead drag the *entire* source graph — `operations` → `build`/`validate` →
 * all six target modules + `yaml` — through jiti's on-the-fly transpiler on **every** config load.
 * With one fresh jiti instance per load, that meant re-transpiling the whole package hundreds of
 * times across the test suite, blocking the vitest worker long enough to trip its `onTaskUpdate`
 * RPC timeout intermittently on slow CI. Pointing the alias at the minimal `config` module keeps
 * each load's transpile graph tiny. (Production is unaffected either way — `dist/*.js` is already
 * compiled, so jiti loads it without transpiling.)
 */
function coreConfigEntrypoint(): string {
  const here = fileURLToPath(import.meta.url);
  // here = <pkgRoot>/<src|dist>/pipeline/load-config.<ts|js>; config.ts sits two levels up.
  return path.join(path.dirname(here), '..', 'config');
}

/** Absolute path to a plugin's `aipm.config.ts`, given the plugin directory. */
function configPathFor(pluginDir: string): string {
  return path.join(pluginDir, AIPM_CONFIG_FILENAME);
}

/**
 * Transpile-import a config module's `default` export via jiti, with the core package specifier
 * aliased to this package's entrypoint (so a bare `import '@ai-plugin-marketplace/core'` resolves
 * regardless of where the config file lives). Shared by {@link loadPluginConfig} and
 * {@link loadRepoConfig}.
 *
 * @throws {ConfigLoadError} If the module fails to import or has no usable default export.
 */
export async function importDefaultExport(configPath: string, filename: string): Promise<unknown> {
  const jiti = createJiti(import.meta.url, {
    alias: { [CORE_PACKAGE_SPECIFIER]: coreConfigEntrypoint() },
    // Disable the default↔namespace interop so a config with no `default` export reads as a
    // genuinely-absent default rather than jiti synthesizing one from the namespace.
    interopDefault: false,
    // `moduleCache: false` so a config rewritten in-process (tests, freshness re-reads) is
    // re-evaluated rather than served stale from jiti's in-memory, path-keyed module cache.
    moduleCache: false,
    // `fsCache: true` (jiti's default) caches the expensive *transpile* on disk, keyed by a hash
    // of the source — so it is correctness-safe across rewrites (changed content → new key →
    // recompile) while letting the many identical config loads in one run skip re-transpiling.
    // This is the dominant per-load cost; caching it keeps the (jiti-heavy) test suite from
    // pegging a worker long enough to trip vitest's birpc heartbeat ("Timeout calling onTaskUpdate").
    fsCache: true,
  });

  let mod: Record<string, unknown>;
  try {
    mod = await jiti.import<Record<string, unknown>>(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Failed to import ${filename}: ${message}`, { cause: err });
  }

  const defaultExport = mod['default'];
  if (defaultExport === undefined || defaultExport === null) {
    throw new ConfigLoadError(
      `${filename} at ${configPath} has no default export. Export the result of the matching \`define*({...})\` call as default.`,
    );
  }
  return defaultExport;
}

/**
 * A per-invocation memo of loaded plugin configs, keyed by absolute plugin directory. Created
 * fresh by an orchestrator (`runBuild`/`runValidate`) and threaded through the helpers it calls,
 * so a single invocation transpiles each `aipm.config.ts` **once** instead of repeatedly (the
 * build loop, registry collection, and post-build validate would otherwise each reload every
 * config — an expensive jiti transpile with module/fs caching disabled).
 *
 * Intentionally **per-invocation, not a module-level cache**: configs are static within one CLI
 * run but may change between runs (and tests overwrite-and-reload across invocations), so a
 * longer-lived cache would risk serving stale parses. Each `createConfigCache()` lives only for
 * the orchestrator call that created it.
 *
 * @public
 */
export type ConfigCache = Map<string, AipmConfig>;

/** Create an empty {@link ConfigCache} for a single orchestrator invocation. */
export function createConfigCache(): ConfigCache {
  return new Map();
}

/**
 * Load and validate a plugin's `aipm.config.ts`, returning the branded {@link AipmConfig}.
 *
 * The on-disk module's `default` export is re-validated through {@link defineConfig} so callers
 * receive a value that provably passed the canonical Zod schema — even if the author bypassed
 * `defineConfig` in their source (e.g. exported a plain object literal).
 *
 * @param pluginDir - Absolute path to the `plugins/<name>/` directory.
 * @param cache - Optional per-invocation memo (see {@link ConfigCache}). When supplied, a config
 *   already loaded in this invocation is returned without re-transpiling.
 * @returns The validated, branded config.
 * @throws {ConfigLoadError} If the file is absent, fails to import, has no default export, or
 *   the default export fails schema validation.
 */
export async function loadPluginConfig(
  pluginDir: string,
  cache?: ConfigCache,
): Promise<AipmConfig> {
  const cached = cache?.get(pluginDir);
  if (cached !== undefined) return cached;

  const configPath = configPathFor(pluginDir);

  if (!fs.existsSync(configPath)) {
    throw new ConfigLoadError(
      `No ${AIPM_CONFIG_FILENAME} found in ${pluginDir}. Every plugin must declare a support envelope (spec §6.1).`,
    );
  }

  const defaultExport = await importDefaultExport(configPath, AIPM_CONFIG_FILENAME);

  // Re-validate through defineConfig so the result is a branded AipmConfig. defineConfig throws
  // a ZodError on malformed input; wrap it so callers get a single ConfigLoadError type.
  let config: AipmConfig;
  try {
    config = defineConfig(defaultExport as AipmConfigInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Invalid ${AIPM_CONFIG_FILENAME}: ${message}`, { cause: err });
  }
  cache?.set(pluginDir, config);
  return config;
}

/**
 * Resolved repo-level configuration: the plugins/dist roots after defaults are applied. These are
 * repo-root-relative directory names that {@link discoverPlugins} joins onto the repo root.
 */
export interface ResolvedRepoConfig {
  /** Directory (relative to the repo root) holding plugin folders. Default: `'plugins'`. */
  pluginsRoot: string;
  /** Directory (relative to the repo root) for generated dist bundles. Default: `'dist'`. */
  distDir: string;
}

/** The resolved config used when no `aipm.repo.ts` is present — i.e. the historical topology. */
export const DEFAULT_REPO_CONFIG: ResolvedRepoConfig = { pluginsRoot: 'plugins', distDir: 'dist' };

/** True iff `repoRoot` contains an `aipm.repo.ts`. */
export function hasRepoConfig(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, AIPM_REPO_CONFIG_FILENAME));
}

/**
 * Load the optional `aipm.repo.ts` at `repoRoot`, returning the resolved plugins/dist roots.
 *
 * When the file is **absent**, returns {@link DEFAULT_REPO_CONFIG} — so a repo with no repo
 * config is byte-identical to the historical behavior. When **present**, the module's `default`
 * export is re-validated through `defineRepoConfig` (applying defaults, rejecting absolute/`..`
 * paths and unknown keys).
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The resolved repo config.
 * @throws {ConfigLoadError} If the file exists but cannot be imported or fails validation.
 */
export async function loadRepoConfig(repoRoot: string): Promise<ResolvedRepoConfig> {
  const configPath = path.join(repoRoot, AIPM_REPO_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_REPO_CONFIG };
  }

  const defaultExport = await importDefaultExport(configPath, AIPM_REPO_CONFIG_FILENAME);

  try {
    const config = defineRepoConfig(defaultExport as AipmRepoConfigInput);
    return { pluginsRoot: config.pluginsRoot, distDir: config.distDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Invalid ${AIPM_REPO_CONFIG_FILENAME}: ${message}`, { cause: err });
  }
}

/** True iff `repoRoot` contains an `aipm.workspace.ts` (i.e. registry generation is opted in). */
export function hasWorkspaceConfig(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, AIPM_WORKSPACE_CONFIG_FILENAME));
}

/**
 * Load the optional `aipm.workspace.ts` at `repoRoot`, returning the validated, branded
 * {@link AipmWorkspace}.
 *
 * When the file is **absent**, returns `undefined` — the signal that this repo has NOT opted into
 * registry generation (the toolkit then leaves the hand-authored registries alone). When
 * **present**, the module's `default` export is re-validated through `defineWorkspace` so the
 * result provably passed the canonical schema.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The validated workspace config, or `undefined` when no `aipm.workspace.ts` exists.
 * @throws {ConfigLoadError} If the file exists but cannot be imported or fails validation.
 */
export async function loadWorkspaceConfig(repoRoot: string): Promise<AipmWorkspace | undefined> {
  const configPath = path.join(repoRoot, AIPM_WORKSPACE_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  const defaultExport = await importDefaultExport(configPath, AIPM_WORKSPACE_CONFIG_FILENAME);

  try {
    return defineWorkspace(defaultExport as AipmWorkspaceInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Invalid ${AIPM_WORKSPACE_CONFIG_FILENAME}: ${message}`, {
      cause: err,
    });
  }
}
