/**
 * Tests for plugin discovery (single-plugin vs repo-root detection, embedded-marketplace roots).
 *
 * @see docs/specs/architecture.md §8.1 ("Why one build signature"), §3.2 (topology)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // A plugins/* dir that is not plugin-shaped (no config, no manifests, no skills) is ignored —
    // it is not a plugin at all (non-goal, see the "plugin-shaped" describe block below for the
    // config-less-but-shaped case, which IS discovered).
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

describe('discoverPlugins — repo root, plugin-shaped but config-less (#91)', () => {
  /** Write a minimal (content-agnostic) file, creating parent directories as needed. */
  function writeFile(dir: string, rel: string, content = '{}'): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('discovers a plugins/* directory with a target manifest but no aipm.config.ts', async () => {
    writeConfig(path.join(root, 'plugins', 'alpha'));
    // Repro shape from #91: target manifest present, aipm.config.ts absent (e.g. moved aside).
    writeFile(path.join(root, 'plugins', 'broken'), '.claude-plugin/plugin.json');

    const result = await discoverPlugins(root);

    expect(result.pluginDirs.map((p) => path.basename(p)).sort()).toStrictEqual([
      'alpha',
      'broken',
    ]);
  });

  it('discovers a plugins/* directory with only a skill and no aipm.config.ts', async () => {
    writeFile(path.join(root, 'plugins', 'skill-only'), 'skills/my-skill/SKILL.md', '# Skill\n');

    const result = await discoverPlugins(root);

    expect(result.pluginDirs.map((p) => path.basename(p))).toStrictEqual(['skill-only']);
  });

  it.each<[string, string]>([
    ['claude', '.claude-plugin/plugin.json'],
    ['codex', '.codex-plugin/plugin.json'],
    ['cursor', '.cursor-plugin/plugin.json'],
    ['gemini', 'gemini-extension.json'],
    ['kiro', 'POWER.md'],
    ['open-plugins', '.plugin/plugin.json'],
  ])(
    'discovers a config-less %s-shaped directory via its manifest marker',
    async (_target, rel) => {
      writeFile(path.join(root, 'plugins', 'shaped'), rel);

      const result = await discoverPlugins(root);

      expect(result.pluginDirs.map((p) => path.basename(p))).toStrictEqual(['shaped']);
    },
  );

  it('still ignores a plugins/* directory with an unrelated file and no plugin-shape marker', async () => {
    // A stray README (or any non-marker file) does not make a directory plugin-shaped.
    writeFile(path.join(root, 'plugins', 'not-a-plugin'), 'README.md', '# Notes\n');

    const result = await discoverPlugins(root);

    expect(result.pluginDirs).toStrictEqual([]);
  });

  it('still ignores an empty plugins/* directory with no files at all', async () => {
    fs.mkdirSync(path.join(root, 'plugins', 'totally-empty'), { recursive: true });

    const result = await discoverPlugins(root);

    expect(result.pluginDirs).toStrictEqual([]);
  });
});

describe('discoverPlugins — single plugin', () => {
  it('treats a directory with a config as a single plugin in the default plugins layout', async () => {
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

  it.each(['demo', 'extensions/ai/plugins/demo'])(
    'resolves %s to the owning repo and dist directory with a nested pluginsRoot',
    async (argument) => {
      writeRepoConfig(root, "{ pluginsRoot: 'extensions/ai/plugins', distDir: 'build-out' }");
      const pluginDir = path.join(root, 'extensions/ai/plugins/demo');
      writeConfig(pluginDir);

      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
      try {
        await expect(discoverPlugins(argument)).resolves.toStrictEqual({
          isRepoRoot: false,
          repoRoot: root,
          distDir: path.join(root, 'build-out'),
          pluginDirs: [pluginDir],
        });
      } finally {
        cwd.mockRestore();
      }
    },
  );

  it('assigns a shared plugins root to the nearer configured repo for both arguments and scans', async () => {
    writeRepoConfig(root, "{ pluginsRoot: 'extensions/ai/plugins', distDir: 'outer-dist' }");
    const inner = path.join(root, 'extensions/ai');
    writeRepoConfig(inner, "{ pluginsRoot: 'plugins', distDir: 'inner-dist' }");
    const pluginDir = path.join(inner, 'plugins/demo');
    writeConfig(pluginDir);

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const expected = {
        repoRoot: inner,
        distDir: path.join(inner, 'inner-dist'),
        pluginDirs: [pluginDir],
      };
      await expect(discoverPlugins('demo')).resolves.toMatchObject(expected);
      await expect(discoverPlugins('extensions/ai/plugins/demo')).resolves.toMatchObject(expected);
      await expect(discoverPlugins(inner)).resolves.toMatchObject(expected);
      await expect(discoverPlugins(root)).resolves.toMatchObject({ pluginDirs: [] });
    } finally {
      cwd.mockRestore();
    }
  });

  it('uses a nested default layout when the enclosing config declares an unrelated plugins root', async () => {
    writeRepoConfig(root, "{ pluginsRoot: 'agent-plugins', distDir: 'outer-dist' }");
    const inner = path.join(root, 'vendor/inner');
    const pluginDir = path.join(inner, 'plugins/demo');
    writeConfig(pluginDir);

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(inner);
    try {
      const expected = {
        repoRoot: inner,
        distDir: path.join(inner, 'dist'),
        pluginDirs: [pluginDir],
      };
      for (const argument of ['.', 'demo', 'plugins/demo']) {
        await expect(discoverPlugins(argument)).resolves.toMatchObject(expected);
      }
    } finally {
      cwd.mockRestore();
    }
  });

  it('uses the same physical plugins root for discovery through a configured symlink', async () => {
    writeRepoConfig(root, "{ pluginsRoot: 'agent-plugins', distDir: 'build-out' }");
    const pluginDir = path.join(root, 'extensions/authored/demo');
    writeConfig(pluginDir);
    fs.symlinkSync(path.dirname(pluginDir), path.join(root, 'agent-plugins'), 'junction');
    fs.symlinkSync(pluginDir, path.join(path.dirname(pluginDir), 'alias'), 'junction');

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const expected = {
        repoRoot: root,
        distDir: path.join(root, 'build-out'),
        pluginDirs: [pluginDir],
      };
      for (const argument of ['.', 'demo', 'agent-plugins/demo', pluginDir]) {
        await expect(discoverPlugins(argument)).resolves.toMatchObject(expected);
      }
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects a configured plugins root that resolves outside the repo', async () => {
    const repo = path.join(root, 'marketplace');
    writeRepoConfig(repo, "{ pluginsRoot: 'agent-plugins' }");
    const outside = path.join(root, 'outside');
    writeConfig(path.join(outside, 'demo'));
    fs.symlinkSync(outside, path.join(repo, 'agent-plugins'), 'junction');

    await expect(discoverPlugins(repo)).rejects.toThrow(/pluginsRoot.*outside/);
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
