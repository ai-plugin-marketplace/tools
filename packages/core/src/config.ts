/**
 * Plugin author configuration — `aipm.config.ts`.
 *
 * Per §6.1 of the architecture spec, `defineConfig` takes an `AipmConfigInput` and returns a
 * branded `AipmConfig`. The brand symbol is module-private (never exported); consumers see
 * `AipmConfig` as `AipmConfigInput` plus a structural marker proving `defineConfig` validated
 * the value.
 */

import * as path from 'node:path';

import { z } from 'zod';
import type { TargetId } from './pipeline/types.js';
import { TARGET_IDS } from './pipeline/types.js';

/**
 * Raw input shape accepted by `defineConfig`. Plugin authors type their config literal against
 * `AipmConfigInput` implicitly via `defineConfig`'s parameter.
 *
 * @public
 */
export interface AipmConfigInput {
  /** Semver string identifying the plugin author's release. See §9.5 of the spec. */
  version: string;
  /** Targets this plugin supports. See §6 of the spec. */
  targets: readonly TargetId[];
}

/**
 * Module-private brand marker. Intentionally never exported (§8.1: "The brand symbol is
 * module-private"). Marked `@internal` so API Extractor does not flag `AipmConfig`'s reference
 * to it as `ae-forgotten-export`; the symbol carries no runtime value and does not appear in the
 * trimmed public rollup.
 *
 * @internal
 */
declare const aipmConfigBrand: unique symbol;

/**
 * Validated plugin configuration. Structurally identical to `AipmConfigInput` but carries a
 * module-private brand indicating `defineConfig` validated it at runtime.
 *
 * @public
 */
export type AipmConfig = AipmConfigInput & {
  readonly [aipmConfigBrand]: 'AipmConfig';
};

/**
 * Zod schema used for runtime validation. Uses `.strict()` to reject unknown keys.
 *
 * `version` must parse as semver. `targets` must be a non-empty subset of known target IDs and
 * must not contain duplicates.
 */
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const aipmConfigSchema = z
  .object({
    version: z.string().regex(semverPattern, 'version must be a valid semver string'),
    targets: z
      .array(z.enum(TARGET_IDS))
      .min(1, 'targets must contain at least one target')
      .refine((arr) => new Set(arr).size === arr.length, 'targets must not contain duplicates'),
  })
  .strict();

/**
 * Validate and brand a plugin configuration. Throws a `ZodError` on invalid input.
 *
 * @public
 */
export function defineConfig(config: AipmConfigInput): AipmConfig {
  const parsed = aipmConfigSchema.parse(config);
  // Brand injection: the parsed value is structurally AipmConfigInput; the brand is a
  // type-only marker proving validation ran. Cast through `unknown` per TS guidance.
  return parsed as unknown as AipmConfig;
}

// ---------------------------------------------------------------------------
// Repo-level configuration — `aipm.repo.ts` (embedded-marketplace support)
// ---------------------------------------------------------------------------

/**
 * Raw input shape accepted by `defineRepoConfig`. Authored as `aipm.repo.ts` at the **repo
 * root** of a project that hosts a marketplace inside a larger software repo. The file is
 * optional: when absent, the toolkit behaves as if `defineRepoConfig({})` was used, reproducing
 * the historical "repo root == marketplace root, fixed `plugins/`" topology.
 *
 * Both paths are repo-root-relative and must stay within the repo (no absolute paths, no `..`
 * segments), because host platforms resolve a plugin's `source` relative to the repo root.
 *
 * @public
 */
export interface AipmRepoConfigInput {
  /**
   * Directory (relative to the repo root) that holds plugin folders. Relocate this when the host
   * software already owns a top-level `plugins/` directory. Default: `'plugins'`.
   */
  pluginsRoot?: string;
  /**
   * Directory (relative to the repo root) for generated `dist/` bundles. Relocate this when the
   * host software already owns a top-level `dist/`. Default: `'dist'`.
   */
  distDir?: string;
}

/**
 * Module-private brand marker for {@link AipmRepoConfig}. Never exported.
 *
 * @internal
 */
declare const aipmRepoConfigBrand: unique symbol;

/**
 * Validated repo configuration. Carries a module-private brand indicating `defineRepoConfig`
 * validated it; unlike the input, both fields are always present (defaults applied).
 *
 * @public
 */
export type AipmRepoConfig = {
  readonly pluginsRoot: string;
  readonly distDir: string;
} & { readonly [aipmRepoConfigBrand]: 'AipmRepoConfig' };

/**
 * A repo-relative path that is safe to join onto the repo root: non-empty, not absolute, and
 * containing no `..` segment that could escape the repo. Host platforms resolve plugin `source`
 * paths relative to the repo root, so an escaping root would be unrepresentable.
 */
const repoRelativePath = z
  .string()
  .min(1, 'path must not be empty')
  .refine((p) => !path.isAbsolute(p), 'path must be relative to the repo root, not absolute')
  .refine(
    (p) => !p.split(/[\\/]/).includes('..'),
    "path must not contain a '..' segment (it must stay within the repo root)",
  );

const aipmRepoConfigSchema = z
  .object({
    pluginsRoot: repoRelativePath.default('plugins'),
    distDir: repoRelativePath.default('dist'),
  })
  .strict();

/**
 * Validate and brand a repo configuration, applying defaults for any omitted field. Throws a
 * `ZodError` on invalid input (unknown keys, absolute paths, `..` escapes).
 *
 * @public
 */
export function defineRepoConfig(config: AipmRepoConfigInput = {}): AipmRepoConfig {
  const parsed = aipmRepoConfigSchema.parse(config);
  return parsed as unknown as AipmRepoConfig;
}
