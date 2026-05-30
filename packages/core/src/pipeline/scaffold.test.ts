/**
 * Tests for the scaffolding + compatibility-assist pipeline orchestrators.
 *
 * Uses real temp directories (`fs.mkdtempSync`) following the pattern in
 * `targets/gemini/bundle.test.ts`. Covers `runScaffold` (file set + valid aipm.config.ts),
 * `runAddTarget` (adds files, refuses overwrite, updates the envelope), and `runCheckSupport`
 * (declared/missingArtifacts/suggestions for hand-built fixtures). Includes negative cases.
 *
 * @see docs/specs/architecture.md §6, §6.4, §12.5
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_IDS } from './types.js';
import {
  parseDeclaredTargets,
  renderAipmConfig,
  runAddTarget,
  runCheckSupport,
  runScaffold,
  validatePluginName,
} from './scaffold.js';

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-scaffold-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

/** Read a file under a plugin dir; '' if absent. */
function read(pluginDir: string, rel: string): string {
  const full = path.join(pluginDir, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
}

/** Hand-build a plugin fixture: write aipm.config.ts with the given targets plus extra files. */
function buildFixture(targets: readonly string[], extraFiles: Record<string, string> = {}): string {
  const pluginDir = path.join(tmpDir, 'fixture-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  const targetList = targets.map((t) => `'${t}'`).join(', ');
  fs.writeFileSync(
    path.join(pluginDir, 'aipm.config.ts'),
    `import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: [${targetList}],\n});\n`,
    'utf-8',
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(pluginDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return pluginDir;
}

// ---------------------------------------------------------------------------
// validatePluginName
// ---------------------------------------------------------------------------

describe('validatePluginName', () => {
  it('accepts a valid slug', () => {
    expect(() => {
      validatePluginName('my-plugin');
    }).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['My-Plugin', 'uppercase'],
    ['1plugin', 'leading digit'],
    ['my--plugin', 'consecutive hyphens'],
    ['my-plugin-', 'trailing hyphen'],
    ['my_plugin', 'underscore'],
  ])('rejects %s (%s)', (name) => {
    expect(() => {
      validatePluginName(name);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderAipmConfig / parseDeclaredTargets round-trip
// ---------------------------------------------------------------------------

describe('renderAipmConfig + parseDeclaredTargets', () => {
  it('round-trips a target set in canonical order', () => {
    const source = renderAipmConfig(['gemini', 'claude']);
    expect(parseDeclaredTargets(source)).toStrictEqual(['claude', 'gemini']);
  });

  it('emits version 0.1.0 and a defineConfig call', () => {
    const source = renderAipmConfig(['claude']);
    expect(source).toContain("version: '0.1.0'");
    expect(source).toContain('defineConfig(');
  });

  it('ignores unknown target IDs when parsing (negative)', () => {
    const source =
      "export default defineConfig({ version: '0.1.0', targets: ['claude', 'bogus'] });";
    expect(parseDeclaredTargets(source)).toStrictEqual(['claude']);
  });

  it('throws when no targets array literal is present (negative)', () => {
    expect(() => parseDeclaredTargets('export default {};')).toThrow(/targets/);
  });
});

// ---------------------------------------------------------------------------
// runScaffold
// ---------------------------------------------------------------------------

describe('runScaffold', () => {
  it('creates the canonical file set for all targets by default', async () => {
    await runScaffold('my-plugin', tmpDir, {});
    const pluginDir = path.join(tmpDir, 'my-plugin');

    for (const rel of [
      'aipm.config.ts',
      'README.md',
      'LICENSE',
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      'gemini-extension.json',
      'GEMINI.md',
      'POWER.md',
      'skills/my-plugin/SKILL.md',
    ]) {
      expect(fs.existsSync(path.join(pluginDir, rel)), `expected ${rel}`).toBe(true);
    }
  });

  it('writes an aipm.config.ts declaring exactly the requested targets', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: ['claude', 'gemini'] });
    const pluginDir = path.join(tmpDir, 'my-plugin');
    expect(parseDeclaredTargets(read(pluginDir, 'aipm.config.ts'))).toStrictEqual([
      'claude',
      'gemini',
    ]);
  });

  it('only scaffolds files for the requested targets', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: ['claude'] });
    const pluginDir = path.join(tmpDir, 'my-plugin');
    expect(fs.existsSync(path.join(pluginDir, '.claude-plugin/plugin.json'))).toBe(true);
    // Gemini was not requested — its manifest must not appear.
    expect(fs.existsSync(path.join(pluginDir, 'gemini-extension.json'))).toBe(false);
  });

  it('threads the description into manifests and README', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: ['claude'], description: 'Specific text' });
    const pluginDir = path.join(tmpDir, 'my-plugin');
    expect(read(pluginDir, '.claude-plugin/plugin.json')).toContain('Specific text');
    expect(read(pluginDir, 'README.md')).toContain('Specific text');
  });

  it('rejects an invalid plugin name (negative)', async () => {
    await expect(runScaffold('Bad-Name', tmpDir, {})).rejects.toThrow(/Invalid plugin name/);
  });

  it('refuses to scaffold over an existing directory (negative)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'my-plugin'), { recursive: true });
    await expect(runScaffold('my-plugin', tmpDir, {})).rejects.toThrow(/already exists/);
  });

  it('is deterministic: two scaffolds produce identical aipm.config.ts', async () => {
    await runScaffold('plugin-a', tmpDir, { targets: ['claude', 'kiro'] });
    await runScaffold('plugin-b', tmpDir, { targets: ['kiro', 'claude'] });
    const a = read(path.join(tmpDir, 'plugin-a'), 'aipm.config.ts');
    const b = read(path.join(tmpDir, 'plugin-b'), 'aipm.config.ts');
    // Differ only in nothing target-related — both render the same canonical targets array.
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// runAddTarget
// ---------------------------------------------------------------------------

describe('runAddTarget', () => {
  it('adds the target skeleton files and updates the envelope', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: ['claude'] });
    const pluginDir = path.join(tmpDir, 'my-plugin');

    await runAddTarget(pluginDir, 'gemini');

    expect(fs.existsSync(path.join(pluginDir, 'gemini-extension.json'))).toBe(true);
    expect(parseDeclaredTargets(read(pluginDir, 'aipm.config.ts'))).toStrictEqual([
      'claude',
      'gemini',
    ]);
  });

  it('refuses to overwrite an existing target file (negative)', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: ['claude', 'gemini'] });
    const pluginDir = path.join(tmpDir, 'my-plugin');

    await expect(runAddTarget(pluginDir, 'gemini')).rejects.toThrow(/Refusing to overwrite/);
  });

  it('is idempotent on the envelope when the target is already declared and files are absent', async () => {
    // Declare gemini but do not create its file, simulating a partial state.
    const pluginDir = buildFixture(['claude', 'gemini']);
    await runAddTarget(pluginDir, 'gemini');
    // Envelope unchanged (still claude + gemini), file now created.
    expect(parseDeclaredTargets(read(pluginDir, 'aipm.config.ts'))).toStrictEqual([
      'claude',
      'gemini',
    ]);
    expect(fs.existsSync(path.join(pluginDir, 'gemini-extension.json'))).toBe(true);
  });

  it('throws and writes nothing when the plugin has no aipm.config.ts (negative)', async () => {
    const pluginDir = path.join(tmpDir, 'no-config');
    fs.mkdirSync(pluginDir, { recursive: true });
    await expect(runAddTarget(pluginDir, 'gemini')).rejects.toThrow(/no aipm.config.ts/);
    // No skeleton leaked.
    expect(fs.existsSync(path.join(pluginDir, 'gemini-extension.json'))).toBe(false);
  });

  it('throws on a missing plugin directory (negative)', async () => {
    await expect(runAddTarget(path.join(tmpDir, 'nope'), 'claude')).rejects.toThrow(
      /does not exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// runCheckSupport
// ---------------------------------------------------------------------------

describe('runCheckSupport', () => {
  it('reports a fully-scaffolded plugin as complete with no missing artifacts', async () => {
    await runScaffold('my-plugin', tmpDir, { targets: TARGET_IDS });
    const report = await runCheckSupport(path.join(tmpDir, 'my-plugin'));

    expect(report.plugin).toBe('my-plugin');
    expect(report.declared).toStrictEqual([...TARGET_IDS]);
    expect(report.missingArtifacts).toStrictEqual([]);
    // All targets declared → nothing left to suggest.
    expect(report.suggestions).toStrictEqual([]);
  });

  it('flags declared targets missing required artifacts', async () => {
    // Declares claude + kiro but provides only the claude manifest.
    const pluginDir = buildFixture(['claude', 'kiro'], {
      '.claude-plugin/plugin.json': '{"name":"fixture-plugin"}',
    });
    const report = await runCheckSupport(pluginDir);

    expect(report.declared).toStrictEqual(['claude', 'kiro']);
    expect(report.missingArtifacts).toStrictEqual([{ target: 'kiro', missing: ['POWER.md'] }]);
  });

  it('suggests undeclared targets with the files the author would need', async () => {
    const pluginDir = buildFixture(['claude'], {
      '.claude-plugin/plugin.json': '{"name":"fixture-plugin"}',
    });
    const report = await runCheckSupport(pluginDir);

    const byTarget = new Map(report.suggestions.map((s) => [s.target, s.wouldNeed]));
    expect(byTarget.get('cursor')).toStrictEqual(['.cursor-plugin/plugin.json']);
    expect(byTarget.get('gemini')).toStrictEqual(['gemini-extension.json']);
    expect(byTarget.get('kiro')).toStrictEqual(['POWER.md']);
    // Vercel's requirement is a directory-scan rule rendered as a guidance path.
    expect(byTarget.get('vercel')).toStrictEqual(['skills/<skill-name>/SKILL.md']);
    // Claude is declared, so it must not be suggested.
    expect(byTarget.has('claude')).toBe(false);
  });

  it('treats a declared vercel target with at least one SKILL.md as satisfied', async () => {
    const pluginDir = buildFixture(['vercel'], {
      'skills/some-skill/SKILL.md': '---\nname: some-skill\ndescription: x\n---\n',
    });
    const report = await runCheckSupport(pluginDir);
    expect(report.missingArtifacts).toStrictEqual([]);
  });

  it('flags a declared vercel target with no skills (negative)', async () => {
    const pluginDir = buildFixture(['vercel']);
    const report = await runCheckSupport(pluginDir);
    expect(report.missingArtifacts).toStrictEqual([
      { target: 'vercel', missing: ['skills/<skill-name>/SKILL.md'] },
    ]);
  });

  it('throws when aipm.config.ts is missing (negative)', async () => {
    const pluginDir = path.join(tmpDir, 'bare');
    fs.mkdirSync(pluginDir, { recursive: true });
    await expect(runCheckSupport(pluginDir)).rejects.toThrow(/No aipm.config.ts/);
  });
});
