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

import { defineConfig } from '../config.js';
import type { AipmConfig, AipmConfigInput } from '../config.js';

/** The canonical config filename every plugin must provide (§6.1). */
export const AIPM_CONFIG_FILENAME = 'aipm.config.ts';

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
 * Absolute path to this package's public entrypoint, **without** a file extension, derived from
 * the location of this module. When bundled to `dist/pipeline/load-config.js` this resolves to
 * `dist/index`; when run from source as `src/pipeline/load-config.ts` it resolves to `src/index`.
 * jiti's resolver appends the correct extension in each case.
 */
function corePackageEntrypoint(): string {
  const here = fileURLToPath(import.meta.url);
  // here = <pkgRoot>/<src|dist>/pipeline/load-config.<ts|js>; index sits two levels up.
  return path.join(path.dirname(here), '..', 'index');
}

/** Absolute path to a plugin's `aipm.config.ts`, given the plugin directory. */
export function configPathFor(pluginDir: string): string {
  return path.join(pluginDir, AIPM_CONFIG_FILENAME);
}

/**
 * Load and validate a plugin's `aipm.config.ts`, returning the branded {@link AipmConfig}.
 *
 * The on-disk module's `default` export is re-validated through {@link defineConfig} so callers
 * receive a value that provably passed the canonical Zod schema — even if the author bypassed
 * `defineConfig` in their source (e.g. exported a plain object literal).
 *
 * @param pluginDir - Absolute path to the `plugins/<name>/` directory.
 * @returns The validated, branded config.
 * @throws {ConfigLoadError} If the file is absent, fails to import, has no default export, or
 *   the default export fails schema validation.
 */
export async function loadPluginConfig(pluginDir: string): Promise<AipmConfig> {
  const configPath = configPathFor(pluginDir);

  if (!fs.existsSync(configPath)) {
    throw new ConfigLoadError(
      `No ${AIPM_CONFIG_FILENAME} found in ${pluginDir}. Every plugin must declare a support envelope (spec §6.1).`,
    );
  }

  const jiti = createJiti(import.meta.url, {
    alias: { [CORE_PACKAGE_SPECIFIER]: corePackageEntrypoint() },
    // Disable the default↔namespace interop so a config with no `default` export reads as a
    // genuinely-absent default rather than jiti synthesizing one from the namespace.
    interopDefault: false,
    // Disable caches so repeated loads (e.g. freshness re-reads) see current disk state.
    moduleCache: false,
    fsCache: false,
  });

  let mod: Record<string, unknown>;
  try {
    mod = await jiti.import<Record<string, unknown>>(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Failed to import ${AIPM_CONFIG_FILENAME}: ${message}`, {
      cause: err,
    });
  }

  const defaultExport = mod.default;
  if (defaultExport === undefined || defaultExport === null) {
    throw new ConfigLoadError(
      `${AIPM_CONFIG_FILENAME} in ${pluginDir} has no default export. Export the result of \`defineConfig({...})\` as default.`,
    );
  }

  // Re-validate through defineConfig so the result is a branded AipmConfig. defineConfig throws
  // a ZodError on malformed input; wrap it so callers get a single ConfigLoadError type.
  try {
    return defineConfig(defaultExport as AipmConfigInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Invalid ${AIPM_CONFIG_FILENAME}: ${message}`, { cause: err });
  }
}
