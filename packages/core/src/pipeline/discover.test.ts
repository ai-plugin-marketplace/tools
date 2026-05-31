/**
 * Tests for plugin discovery (single-plugin vs repo-root detection).
 *
 * @see docs/specs/architecture.md §8.1 ("Why one build signature"), §3.2 (topology)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPlugins } from './discover.js';

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

describe('discoverPlugins — repo root', () => {
  it('discovers every plugins/* directory that carries a config', () => {
    writeConfig(path.join(root, 'plugins', 'alpha'));
    writeConfig(path.join(root, 'plugins', 'beta'));
    // A plugins/* dir WITHOUT a config is ignored.
    fs.mkdirSync(path.join(root, 'plugins', 'no-config'), { recursive: true });

    const result = discoverPlugins(root);

    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.distDir).toBe(path.join(path.resolve(root), 'dist'));
    expect(result.pluginDirs.map((p) => path.basename(p))).toStrictEqual(['alpha', 'beta']);
  });

  it('returns an empty plugin list for a repo root whose plugins/ has no configured plugins', () => {
    fs.mkdirSync(path.join(root, 'plugins', 'empty'), { recursive: true });
    const result = discoverPlugins(root);
    expect(result.pluginDirs).toStrictEqual([]);
  });
});

describe('discoverPlugins — single plugin', () => {
  it('treats a directory with a config as a single plugin and derives dist from the grandparent', () => {
    const pluginDir = path.join(root, 'plugins', 'solo');
    writeConfig(pluginDir);

    const result = discoverPlugins(pluginDir);

    expect(result.pluginDirs).toStrictEqual([path.resolve(pluginDir)]);
    expect(result.repoRoot).toBe(path.resolve(root));
    expect(result.distDir).toBe(path.join(path.resolve(root), 'dist'));
  });

  it('treats a config-less, plugins-less directory as a single-plugin candidate (deferred error)', () => {
    // Missing config is NOT a discovery error — the loader reports envelope-invalid (§10.1.1).
    const pluginDir = path.join(root, 'plugins', 'no-config');
    fs.mkdirSync(pluginDir, { recursive: true });

    const result = discoverPlugins(pluginDir);

    expect(result.pluginDirs).toStrictEqual([path.resolve(pluginDir)]);
  });
});

describe('discoverPlugins — errors', () => {
  it('throws for a path that does not exist', () => {
    expect(() => discoverPlugins(path.join(root, 'nope'))).toThrow(/does not exist/);
  });
});
