/**
 * Tests for plugin discovery (single-plugin vs repo-root detection, embedded-marketplace roots).
 *
 * @see docs/specs/architecture.md §8.1 ("Why one build signature"), §3.2 (topology)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPlugins } from './discover.js';
import { ConfigLoadError } from './load-config.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-discover-'));
});

afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true });
});

/** Write a minimal `aipm.config.ts` into `dir`. */
function writeConfig(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aipm.config.ts'), 'export default {};\n', 'utf-8');
}

/** Write an `aipm.repo.ts` at `dir` exporting the given config object literal. */
function writeRepoConfig(dir: string, configLiteral: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aipm.repo.ts'), `export default ${configLiteral};\n`, 'utf-8');
}

describe('discoverPlugins — repo root', () => {
  it('discovers every plugins/* directory that carries a config', async () => {
    writeConfig(path.join(root, 'plugins', 'alpha'));
    writeConfig(path.join(root, 'plugins', 'beta'));
    // A plugins/* dir WITHOUT a config is ignored.
    fs.mkdirSync(path.join(root, 'plugins', 'no-config'), { recursive: true });

    const result = await discoverPlugins(root);

    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.distDir).toBe(path.join(path.resolve(root), 'dist'));
    expect(result.pluginDirs.map((p) => path.basename(p))).toStrictEqual(['alpha', 'beta']);
  });

  it('returns an empty plugin list for a repo root whose plugins/ has no configured plugins', async () => {
    fs.mkdirSync(path.join(root, 'plugins', 'empty'), { recursive: true });
    const result = await discoverPlugins(root);
    expect(result.pluginDirs).toStrictEqual([]);
  });
});

describe('discoverPlugins — single plugin', () => {
  it('treats a directory with a config as a single plugin and derives dist from the grandparent', async () => {
    const pluginDir = path.join(root, 'plugins', 'solo');
    writeConfig(pluginDir);

    const result = await discoverPlugins(pluginDir);

    expect(result.pluginDirs).toStrictEqual([path.resolve(pluginDir)]);
    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.distDir).toBe(path.join(path.resolve(root), 'dist'));
  });

  it('treats a config-less, plugins-less directory as a single-plugin candidate (deferred error)', async () => {
    // Missing config is NOT a discovery error — the loader reports envelope-invalid (§10.1.1).
    const pluginDir = path.join(root, 'plugins', 'no-config');
    fs.mkdirSync(pluginDir, { recursive: true });

    const result = await discoverPlugins(pluginDir);

    expect(result.pluginDirs).toStrictEqual([path.resolve(pluginDir)]);
  });
});

describe('discoverPlugins — embedded marketplace (aipm.repo.ts)', () => {
  it('discovers plugins under a relocated pluginsRoot', async () => {
    writeRepoConfig(root, `{ pluginsRoot: 'agent-plugins' }`);
    writeConfig(path.join(root, 'agent-plugins', 'alpha'));
    writeConfig(path.join(root, 'agent-plugins', 'beta'));
    // The host software's own (foreign) plugins/ directory is NOT scanned.
    writeConfig(path.join(root, 'plugins', 'host-owned'));

    const result = await discoverPlugins(root);

    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.pluginDirs.map((p) => path.basename(p))).toStrictEqual(['alpha', 'beta']);
  });

  it('honors a relocated distDir', async () => {
    writeRepoConfig(root, `{ pluginsRoot: 'agent-plugins', distDir: 'agent-plugins/dist' }`);
    writeConfig(path.join(root, 'agent-plugins', 'alpha'));

    const result = await discoverPlugins(root);

    expect(result.distDir).toBe(path.join(path.resolve(root), 'agent-plugins', 'dist'));
  });

  it('treats a repo with aipm.repo.ts as a repo root even before the plugins dir exists', async () => {
    // A freshly-initialised embedded repo: config present, no plugins authored yet.
    writeRepoConfig(root, `{ pluginsRoot: 'agent-plugins' }`);

    const result = await discoverPlugins(root);

    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.pluginDirs).toStrictEqual([]);
  });

  it('resolves the relocated distDir for single-plugin input', async () => {
    writeRepoConfig(root, `{ pluginsRoot: 'agent-plugins', distDir: 'build-out' }`);
    const pluginDir = path.join(root, 'agent-plugins', 'solo');
    writeConfig(pluginDir);

    const result = await discoverPlugins(pluginDir);

    expect(result.pluginDirs).toStrictEqual([path.resolve(pluginDir)]);
    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.distDir).toBe(path.join(path.resolve(root), 'build-out'));
  });
});

describe('discoverPlugins — errors', () => {
  it('throws for a path that does not exist', async () => {
    await expect(discoverPlugins(path.join(root, 'nope'))).rejects.toThrow(/does not exist/);
  });

  it('throws ConfigLoadError for an invalid aipm.repo.ts (absolute pluginsRoot)', async () => {
    writeRepoConfig(root, `{ pluginsRoot: '/etc/evil' }`);
    await expect(discoverPlugins(root)).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('rejects a pluginsRoot containing a .. escape', async () => {
    writeRepoConfig(root, `{ pluginsRoot: '../outside' }`);
    await expect(discoverPlugins(root)).rejects.toBeInstanceOf(ConfigLoadError);
  });
});
