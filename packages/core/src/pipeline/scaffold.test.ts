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
import { runValidate } from './validate.js';

interface MarketplaceRegistryShape {
  plugins?: { name: string; source: string }[];
  [key: string]: unknown;
}

/** Parse a marketplace registry file into its typed shape. */
function readRegistry(repoRoot: string, dir: string): MarketplaceRegistryShape {
  const full = path.join(repoRoot, dir, 'marketplace.json');
  return JSON.parse(fs.readFileSync(full, 'utf-8')) as MarketplaceRegistryShape;
}

/** True iff the registry under `repoRoot/<dir>/marketplace.json` exists. */
function registryExists(repoRoot: string, dir: string): boolean {
  return fs.existsSync(path.join(repoRoot, dir, 'marketplace.json'));
}

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
      '.codex-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.plugin/plugin.json',
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
    expect(byTarget.get('codex')).toStrictEqual(['.codex-plugin/plugin.json']);
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

// ---------------------------------------------------------------------------
// Marketplace registration (§4.4, §10.1.4)
// ---------------------------------------------------------------------------

describe('runScaffold — marketplace registration', () => {
  // In a real repo, plugins live under <repoRoot>/plugins/<name>. We mirror that here so
  // repoRoot = dirname(pluginsDir) = tmpDir and the registries land at the repo root.
  function pluginsRoot(): string {
    return path.join(tmpDir, 'plugins');
  }

  it('registers the plugin in both registries when claude+cursor are in the envelope', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude', 'cursor'] });

    const claudeReg = readRegistry(tmpDir, '.claude-plugin');
    const cursorReg = readRegistry(tmpDir, '.cursor-plugin');

    // Source form matches the validator's canonical `./plugins/<name>` (§4.4).
    expect(claudeReg.plugins).toStrictEqual([{ name: 'my-plugin', source: './plugins/my-plugin' }]);
    expect(cursorReg.plugins).toStrictEqual([{ name: 'my-plugin', source: './plugins/my-plugin' }]);
  });

  it('makes the scaffold→validate happy path clean (zero marketplace-registration findings)', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude', 'cursor'] });

    // Validate the whole repo root. Freshness (hooks/dist build artifacts) is a separate
    // build-orchestrator concern not produced by scaffolding, so skip it to isolate the
    // registration assertion — the gap this work closes.
    const result = await runValidate(tmpDir, { skipFreshness: true });

    const registrationFindings = result.findings.filter(
      (f) => f.code === 'marketplace-registration',
    );
    expect(registrationFindings).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });

  it('registers a repo-relative source when the plugins root is relocated (embedded marketplace)', async () => {
    // Embedded layout: the plugins root is `agent-plugins/`, not `plugins/`.
    const relocatedRoot = path.join(tmpDir, 'agent-plugins');
    await runScaffold('my-plugin', relocatedRoot, { targets: ['claude', 'codex'] });

    const claudeReg = readRegistry(tmpDir, '.claude-plugin');
    expect(claudeReg.plugins).toStrictEqual([
      { name: 'my-plugin', source: './agent-plugins/my-plugin' },
    ]);

    // Codex registry uses the object-source shape; its path must also be repo-relative.
    const codexFull = path.join(tmpDir, '.agents', 'plugins', 'marketplace.json');
    const codexReg = JSON.parse(fs.readFileSync(codexFull, 'utf-8')) as {
      plugins: { name: string; source: { source: string; path: string } }[];
    };
    expect(codexReg.plugins[0]?.source).toStrictEqual({
      source: 'local',
      path: './agent-plugins/my-plugin',
    });
  });

  it('makes the embedded scaffold→validate happy path clean (relocated pluginsRoot)', async () => {
    // Declare the relocated root so discovery + validation resolve the same source the scaffolder
    // wrote. Without this fix, scaffold wrote `./plugins/<name>` while validate expected
    // `./agent-plugins/<name>`, producing a spurious marketplace-registration finding.
    fs.writeFileSync(
      path.join(tmpDir, 'aipm.repo.ts'),
      `export default { pluginsRoot: 'agent-plugins' };\n`,
      'utf-8',
    );
    await runScaffold('my-plugin', path.join(tmpDir, 'agent-plugins'), {
      targets: ['claude', 'cursor'],
    });

    const result = await runValidate(tmpDir, { skipFreshness: true });

    const registrationFindings = result.findings.filter(
      (f) => f.code === 'marketplace-registration',
    );
    expect(registrationFindings).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });

  it('creates NO marketplace files when the envelope has neither claude nor cursor', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['gemini'] });

    expect(registryExists(tmpDir, '.claude-plugin')).toBe(false);
    expect(registryExists(tmpDir, '.cursor-plugin')).toBe(false);
  });

  it('registers only the registries implied by the envelope (claude only)', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude', 'gemini'] });

    expect(registryExists(tmpDir, '.claude-plugin')).toBe(true);
    // Cursor not in the envelope → no cursor registry (the validator forbids registering it).
    expect(registryExists(tmpDir, '.cursor-plugin')).toBe(false);
  });

  it('appends a second plugin to an existing registry without dropping the first', async () => {
    await runScaffold('plugin-one', pluginsRoot(), { targets: ['claude'] });
    await runScaffold('plugin-two', pluginsRoot(), { targets: ['claude'] });

    const reg = readRegistry(tmpDir, '.claude-plugin');
    expect(reg.plugins).toStrictEqual([
      { name: 'plugin-one', source: './plugins/plugin-one' },
      { name: 'plugin-two', source: './plugins/plugin-two' },
    ]);
  });

  it('does not duplicate an entry when the plugin is already present (negative)', async () => {
    const repoRoot = tmpDir;
    // Pre-seed a registry that already lists the plugin.
    const claudeDir = path.join(repoRoot, '.claude-plugin');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'marketplace.json'),
      `${JSON.stringify({ plugins: [{ name: 'my-plugin', source: './plugins/my-plugin' }] }, null, 2)}\n`,
      'utf-8',
    );

    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude'] });

    const reg = readRegistry(repoRoot, '.claude-plugin');
    expect(reg.plugins).toStrictEqual([{ name: 'my-plugin', source: './plugins/my-plugin' }]);
  });

  it('writes 2-space JSON with a trailing newline', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude'] });
    const raw = fs.readFileSync(path.join(tmpDir, '.claude-plugin', 'marketplace.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "plugins"');
  });

  it('registers codex in .agents/plugins/marketplace.json with the object-source entry', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['codex'] });

    const codexRegPath = path.join(tmpDir, '.agents', 'plugins', 'marketplace.json');
    expect(fs.existsSync(codexRegPath)).toBe(true);
    const reg = JSON.parse(fs.readFileSync(codexRegPath, 'utf-8')) as {
      plugins?: { name: string; source: { source: string; path: string }; category: string }[];
    };
    // Object source per developers.openai.com/codex/plugins/build, path normalised to ./plugins/<name>.
    expect(reg.plugins).toStrictEqual([
      {
        name: 'my-plugin',
        source: { source: 'local', path: './plugins/my-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ]);
    // Claude/Cursor string-source registries are NOT created for a codex-only envelope.
    expect(registryExists(tmpDir, '.claude-plugin')).toBe(false);
    expect(registryExists(tmpDir, '.cursor-plugin')).toBe(false);
  });

  it('makes the codex scaffold→validate happy path clean (zero marketplace-registration findings)', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude', 'codex'] });

    const result = await runValidate(tmpDir, { skipFreshness: true });
    const registrationFindings = result.findings.filter(
      (f) => f.code === 'marketplace-registration',
    );
    expect(registrationFindings).toStrictEqual([]);
  });
});

describe('runAddTarget — marketplace registration', () => {
  function pluginsRoot(): string {
    return path.join(tmpDir, 'plugins');
  }

  it('registers cursor when adding it to an existing claude-only plugin; idempotent on re-run', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude'] });
    const pluginDir = path.join(pluginsRoot(), 'my-plugin');

    // Before: no cursor registry, cursor file absent.
    expect(registryExists(tmpDir, '.cursor-plugin')).toBe(false);

    await runAddTarget(pluginDir, 'cursor');

    expect(fs.existsSync(path.join(pluginDir, '.cursor-plugin/plugin.json'))).toBe(true);
    expect(readRegistry(tmpDir, '.cursor-plugin').plugins).toStrictEqual([
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);

    // Re-running add-target for the same registry must not duplicate the entry. The skeleton file
    // now exists, so the call refuses to overwrite — but registration must remain a single entry.
    await expect(runAddTarget(pluginDir, 'cursor')).rejects.toThrow(/Refusing to overwrite/);
    expect(readRegistry(tmpDir, '.cursor-plugin').plugins).toStrictEqual([
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);
  });

  it('does not touch any registry when adding a non-registry target (gemini)', async () => {
    await runScaffold('my-plugin', pluginsRoot(), { targets: ['claude'] });
    const pluginDir = path.join(pluginsRoot(), 'my-plugin');
    const claudeBefore = readRegistry(tmpDir, '.claude-plugin');

    await runAddTarget(pluginDir, 'gemini');

    // Gemini is not registry-backed → no new registry, claude registry unchanged.
    expect(registryExists(tmpDir, '.cursor-plugin')).toBe(false);
    expect(readRegistry(tmpDir, '.claude-plugin')).toStrictEqual(claudeBefore);
  });
});
