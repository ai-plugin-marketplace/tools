/**
 * Tests for the runtime `aipm.config.ts` loader (jiti-based, §6.1, P6).
 *
 * These verify the loader can import a TypeScript config that imports `defineConfig` from
 * `@ai-plugin-marketplace/core` (resolved via the jiti alias), re-validate it into a branded
 * `AipmConfig`, and surface every failure mode as a `ConfigLoadError`.
 *
 * @see docs/specs/architecture.md §6.1 (envelope declaration), P6 (TypeScript end-to-end)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoadError, loadPluginConfig } from './load-config.js';

let pluginDir: string;

beforeEach(() => {
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-loadcfg-'));
});

afterEach(() => {
  if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true });
});

/** Write an `aipm.config.ts` with the given source body. */
function writeConfig(source: string): void {
  fs.writeFileSync(path.join(pluginDir, 'aipm.config.ts'), source, 'utf-8');
}

describe('loadPluginConfig — success', () => {
  it('loads a config that imports defineConfig from the core package', async () => {
    writeConfig(
      `import { defineConfig } from '@ai-plugin-marketplace/core';\n` +
        `export default defineConfig({ version: '1.2.3', targets: ['claude', 'gemini'] });\n`,
    );

    const config = await loadPluginConfig(pluginDir);

    expect(config.version).toBe('1.2.3');
    expect(config.targets).toStrictEqual(['claude', 'gemini']);
  });

  it('re-validates a plain-object default export through defineConfig (brand applied)', async () => {
    // Author bypassed defineConfig in source — the loader still brands and validates it.
    writeConfig(`export default { version: '0.1.0', targets: ['kiro'] };\n`);

    const config = await loadPluginConfig(pluginDir);

    expect(config.targets).toStrictEqual(['kiro']);
  });
});

describe('loadPluginConfig — failure modes', () => {
  it('throws ConfigLoadError when aipm.config.ts is absent', async () => {
    await expect(loadPluginConfig(pluginDir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadPluginConfig(pluginDir)).rejects.toThrow(/No aipm\.config\.ts/);
  });

  it('throws ConfigLoadError for an invalid semver version', async () => {
    writeConfig(`export default { version: 'not-semver', targets: ['claude'] };\n`);
    await expect(loadPluginConfig(pluginDir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadPluginConfig(pluginDir)).rejects.toThrow(/Invalid aipm\.config/);
  });

  it('throws ConfigLoadError for an unknown target id', async () => {
    writeConfig(`export default { version: '0.1.0', targets: ['cluade'] };\n`);
    await expect(loadPluginConfig(pluginDir)).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('throws ConfigLoadError for an empty targets array', async () => {
    writeConfig(`export default { version: '0.1.0', targets: [] };\n`);
    await expect(loadPluginConfig(pluginDir)).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('throws ConfigLoadError when there is no default export', async () => {
    writeConfig(`export const notDefault = { version: '0.1.0', targets: ['claude'] };\n`);
    await expect(loadPluginConfig(pluginDir)).rejects.toThrow(/no default export/);
  });

  it('throws ConfigLoadError when the module fails to import (syntax error)', async () => {
    writeConfig(`export default { this is not valid typescript`);
    await expect(loadPluginConfig(pluginDir)).rejects.toBeInstanceOf(ConfigLoadError);
  });
});
