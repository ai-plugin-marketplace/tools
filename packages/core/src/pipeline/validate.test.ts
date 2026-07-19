/**
 * Tests for the cross-target validator pipeline module.
 *
 * @see docs/specs/architecture.md §10.1 (validation contract), §6 (support envelope), §4.4 (marketplace registry)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_REPO, TEMPLATE_REPO_AVAILABLE } from '../test-support/template-repo.js';
import {
  checkDefaultMarketplaceName,
  runValidate,
  validateCrossTarget,
  validateEnvelopeAdherence,
  validateEnvelopeShape,
  validateFrontmatterParses,
  validateMarketplaceRegistration,
  validateMcpKeySync,
  validateNameConsistency,
  validateVersionConsistency,
} from './validate.js';
import { defineWorkspace } from '../config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory rooted under os.tmpdir(). Returns its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-validate-test-'));
}

/**
 * Write a file (and all necessary parent directories) relative to a base directory.
 * `content` may be a string (written as UTF-8) or an object (serialised to JSON).
 */
function write(base: string, rel: string, content: string | object): void {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(full, text, 'utf-8');
}

/** Build a minimal YAML frontmatter string. */
function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n# Body\n`;
}

/**
 * Create a minimal "repo root" with both marketplace.json files listing the given plugin names.
 */
function createRepoRoot(tmpDir: string, pluginNames: string[]): string {
  const repoRoot = path.join(tmpDir, 'repo');
  for (const mktDir of ['.claude-plugin', '.cursor-plugin']) {
    const plugins = pluginNames.map((name) => ({ name, source: `./plugins/${name}` }));
    write(repoRoot, `${mktDir}/marketplace.json`, {
      name: 'test-marketplace',
      owner: { name: 'Test' },
      plugins,
    });
  }
  return repoRoot;
}

/**
 * Create a minimal plugin directory under `pluginDir` for the given targets.
 * Only creates the minimum required artifacts.
 */
function createMinimalPlugin(pluginDir: string, pluginName: string, targets: string[]): void {
  if (targets.includes('claude')) {
    write(pluginDir, '.claude-plugin/plugin.json', { name: pluginName });
  }
  if (targets.includes('cursor')) {
    write(pluginDir, '.cursor-plugin/plugin.json', { name: pluginName });
  }
  if (targets.includes('gemini')) {
    write(pluginDir, 'gemini-extension.json', { name: pluginName });
    write(pluginDir, 'GEMINI.md', `# ${pluginName}`);
  }
  if (targets.includes('kiro')) {
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: pluginName, description: 'test', version: '0.0.1' }),
    );
    write(pluginDir, 'mcp.json', { mcpServers: {} });
  }
  if (targets.includes('vercel')) {
    write(
      pluginDir,
      `skills/${pluginName}/SKILL.md`,
      frontmatter({ name: pluginName, description: 'test' }),
    );
  }
  if (targets.includes('claude') || targets.includes('cursor')) {
    write(pluginDir, '.mcp.json', { mcpServers: {} });
  }
}

/** Write a minimal `aipm.config.ts` declaring `version` (and, for envelope loading, `targets`). */
function writeConfig(pluginDir: string, version: string, targets: readonly string[]): void {
  const targetList = targets.map((t) => `'${t}'`).join(', ');
  write(
    pluginDir,
    'aipm.config.ts',
    `import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '${version}',\n  targets: [${targetList}],\n});\n`,
  );
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateEnvelopeShape
// ---------------------------------------------------------------------------

describe('validateEnvelopeShape()', () => {
  it('returns no findings for a valid config', () => {
    const findings = validateEnvelopeShape(
      { version: '1.0.0', targets: ['claude', 'cursor'] },
      'my-plugin',
    );
    expect(findings).toHaveLength(0);
  });

  it('emits envelope-invalid when version is missing', () => {
    const findings = validateEnvelopeShape({ targets: ['claude'] }, 'my-plugin');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe('envelope-invalid');
    expect(findings[0]?.severity).toBe('hard');
    expect(findings[0]?.plugin).toBe('my-plugin');
  });

  it('emits envelope-invalid for an invalid target ID', () => {
    const findings = validateEnvelopeShape(
      { version: '1.0.0', targets: ['notarget'] },
      'my-plugin',
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe('envelope-invalid');
  });

  it('emits envelope-invalid for an unknown extra key (.strict() behaviour)', () => {
    const findings = validateEnvelopeShape(
      { version: '1.0.0', targets: ['claude'], extra: 'should-fail' },
      'my-plugin',
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe('envelope-invalid');
  });

  it('emits envelope-invalid for an empty targets array', () => {
    const findings = validateEnvelopeShape({ version: '1.0.0', targets: [] }, 'my-plugin');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe('envelope-invalid');
  });

  it('emits envelope-invalid for a non-semver version', () => {
    const findings = validateEnvelopeShape({ version: 'v1', targets: ['claude'] }, 'my-plugin');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe('envelope-invalid');
  });

  it('populates the plugin field from pluginName', () => {
    const findings = validateEnvelopeShape({ targets: ['claude'] }, 'special-plugin');
    expect(findings[0]?.plugin).toBe('special-plugin');
  });
});

// ---------------------------------------------------------------------------
// validateEnvelopeAdherence
// ---------------------------------------------------------------------------

describe('validateEnvelopeAdherence()', () => {
  it('returns no findings when plugin perfectly matches its envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    createMinimalPlugin(pluginDir, 'my-plugin', ['claude', 'cursor']);
    const findings = validateEnvelopeAdherence(pluginDir, ['claude', 'cursor']);
    expect(findings).toHaveLength(0);
  });

  it('emits envelope-adherence when a non-envelope target artifact exists', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    createMinimalPlugin(pluginDir, 'my-plugin', ['claude']);
    // Write a gemini artifact for a plugin that only declares claude
    write(pluginDir, 'gemini-extension.json', { name: 'my-plugin' });

    const findings = validateEnvelopeAdherence(pluginDir, ['claude']);
    expect(
      findings.some((f) => f.code === 'envelope-adherence' && f.message.includes('gemini')),
    ).toBe(true);
  });

  it('emits envelope-adherence when minimum required artifact is missing', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    // Create plugin dir without the claude artifact
    fs.mkdirSync(pluginDir, { recursive: true });

    const findings = validateEnvelopeAdherence(pluginDir, ['claude']);
    expect(
      findings.some(
        (f) => f.code === 'envelope-adherence' && f.message.includes('.claude-plugin/plugin.json'),
      ),
    ).toBe(true);
  });

  it('emits envelope-adherence for vercel when no skills/*/SKILL.md exists', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });

    const findings = validateEnvelopeAdherence(pluginDir, ['vercel']);
    expect(
      findings.some((f) => f.code === 'envelope-adherence' && f.message.includes('vercel')),
    ).toBe(true);
  });

  it('returns no findings for vercel when skills/*/SKILL.md exists', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, 'skills/my-skill/SKILL.md', '# skill');

    const findings = validateEnvelopeAdherence(pluginDir, ['vercel']);
    expect(findings).toHaveLength(0);
  });

  it('emits envelope-adherence when .mcp.json exists but neither claude nor cursor is in envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    createMinimalPlugin(pluginDir, 'my-plugin', ['gemini']);
    // Write a shared MCP artifact for a plugin that only declares gemini
    write(pluginDir, '.mcp.json', { mcpServers: {} });

    const findings = validateEnvelopeAdherence(pluginDir, ['gemini']);
    expect(
      findings.some((f) => f.code === 'envelope-adherence' && f.message.includes('.mcp.json')),
    ).toBe(true);
  });

  it('emits findings for all violations without short-circuiting', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    // claude in envelope but missing plugin.json; kiro not in envelope but POWER.md exists
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'my-plugin', description: 'test', version: '0.0.1' }),
    );

    const findings = validateEnvelopeAdherence(pluginDir, ['claude']);
    // Should have at least: missing .claude-plugin/plugin.json AND POWER.md for non-envelope kiro
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// validateNameConsistency
// ---------------------------------------------------------------------------

describe('validateNameConsistency()', () => {
  it('returns no findings when all names match the directory', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    createMinimalPlugin(pluginDir, 'my-plugin', ['claude', 'cursor', 'gemini', 'kiro']);

    const findings = validateNameConsistency(pluginDir, ['claude', 'cursor', 'gemini', 'kiro']);
    expect(findings).toHaveLength(0);
  });

  it('emits name-consistency when claude manifest name mismatches directory', () => {
    const pluginDir = path.join(tmpDir, 'bar');
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'foo' });

    const findings = validateNameConsistency(pluginDir, ['claude']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('name-consistency');
    expect(findings[0]?.message).toContain('foo');
    expect(findings[0]?.message).toContain('bar');
  });

  it('emits name-consistency when kiro POWER.md frontmatter name mismatches directory', () => {
    const pluginDir = path.join(tmpDir, 'bar');
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'different-name', description: 'test', version: '0.0.1' }),
    );

    const findings = validateNameConsistency(pluginDir, ['kiro']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('name-consistency');
    expect(findings[0]?.message).toContain('different-name');
    expect(findings[0]?.message).toContain('bar');
  });

  it('emits one finding per mismatched manifest (not a single combined finding)', () => {
    const pluginDir = path.join(tmpDir, 'bar');
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'wrong-name' });
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'also-wrong', description: 'test', version: '0.0.1' }),
    );

    const findings = validateNameConsistency(pluginDir, ['claude', 'kiro']);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === 'name-consistency')).toBe(true);
  });

  it('skips vercel (no top-level name field)', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, 'skills/my-skill/SKILL.md', '# skill');

    const findings = validateNameConsistency(pluginDir, ['vercel']);
    expect(findings).toHaveLength(0);
  });

  it('skips manifests that do not exist', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    // No manifest files created

    const findings = validateNameConsistency(pluginDir, ['claude', 'cursor', 'gemini', 'kiro']);
    // No manifest = nothing to compare — no findings
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateVersionConsistency
// ---------------------------------------------------------------------------

describe('validateVersionConsistency()', () => {
  // Acceptance criterion 2: no finding when all in-envelope manifests' versions equal the
  // config version.
  it('returns no findings when all manifest versions match aipm.config.ts', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude', 'cursor', 'gemini', 'kiro']);
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'my-plugin', version: '1.2.3' });
    write(pluginDir, '.cursor-plugin/plugin.json', { name: 'my-plugin', version: '1.2.3' });
    write(pluginDir, 'gemini-extension.json', { name: 'my-plugin', version: '1.2.3' });
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'my-plugin', description: 'test', version: '1.2.3' }),
    );

    const findings = await validateVersionConsistency(pluginDir, [
      'claude',
      'cursor',
      'gemini',
      'kiro',
    ]);
    expect(findings).toHaveLength(0);
  });

  // Acceptance criterion 1: emits a hard version-consistency finding naming the manifest path,
  // the manifest's version, and the expected config version.
  it('emits a hard version-consistency finding for a claude manifest version mismatch', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude']);
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'my-plugin', version: '0.9.0' });

    const findings = await validateVersionConsistency(pluginDir, ['claude']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('hard');
    expect(findings[0]?.code).toBe('version-consistency');
    expect(findings[0]?.message).toContain('.claude-plugin/plugin.json');
    expect(findings[0]?.message).toContain('0.9.0');
    expect(findings[0]?.message).toContain('1.2.3');
  });

  // Regression test: hard()'s second positional argument is Finding.plugin (the plugin directory
  // basename), NOT the value under comparison. A prior version of this check passed
  // `expectedVersion` there by mistake (copied from validateNameConsistency, where
  // `expectedName === path.basename(pluginDir)` coincidentally made the same mistake invisible),
  // which misattributed every finding to a "plugin" named like a version string (e.g. '1.2.3').
  it('sets Finding.plugin to the plugin directory basename, not the expected version', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude']);
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'my-plugin', version: '0.9.0' });

    const findings = await validateVersionConsistency(pluginDir, ['claude']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.plugin).toBe('my-plugin');
    expect(findings[0]?.plugin).not.toBe('1.2.3');
  });

  it('emits version-consistency when kiro POWER.md frontmatter version mismatches the config', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['kiro']);
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'my-plugin', description: 'test', version: '0.9.0' }),
    );

    const findings = await validateVersionConsistency(pluginDir, ['kiro']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('version-consistency');
    expect(findings[0]?.message).toContain('POWER.md');
    expect(findings[0]?.message).toContain('0.9.0');
    expect(findings[0]?.message).toContain('1.2.3');
  });

  // Acceptance criterion 3: one finding per mismatched manifest, mirroring name-consistency.
  it('emits one finding per mismatched manifest (not a single combined finding)', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude', 'cursor']);
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'my-plugin', version: '0.9.0' });
    write(pluginDir, '.cursor-plugin/plugin.json', { name: 'my-plugin', version: '0.8.0' });

    const findings = await validateVersionConsistency(pluginDir, ['claude', 'cursor']);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === 'version-consistency')).toBe(true);
  });

  it('skips vercel (no top-level version field)', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['vercel']);
    write(pluginDir, 'skills/my-skill/SKILL.md', '# skill');

    const findings = await validateVersionConsistency(pluginDir, ['vercel']);
    expect(findings).toHaveLength(0);
  });

  // Acceptance criterion 4: a manifest that is absent produces no version-consistency finding.
  it('skips manifests that do not exist', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude', 'cursor', 'gemini', 'kiro']);
    // No manifest files created

    const findings = await validateVersionConsistency(pluginDir, [
      'claude',
      'cursor',
      'gemini',
      'kiro',
    ]);
    expect(findings).toHaveLength(0);
  });

  // Acceptance criterion 4: a manifest present but without a `version` field does not fabricate
  // a mismatch.
  it('does not fire when a present manifest declares no version field', async () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    writeConfig(pluginDir, '1.2.3', ['claude', 'gemini']);
    write(pluginDir, '.claude-plugin/plugin.json', { name: 'my-plugin' });
    write(pluginDir, 'gemini-extension.json', { name: 'my-plugin' });

    const findings = await validateVersionConsistency(pluginDir, ['claude', 'gemini']);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateMcpKeySync
// ---------------------------------------------------------------------------

describe('validateMcpKeySync()', () => {
  it('returns no findings when .mcp.json and mcp.json have matching keys', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, '.mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });
    write(pluginDir, 'mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['claude', 'kiro']);
    expect(findings).toHaveLength(0);
  });

  it('emits mcp-key-sync when keys diverge between .mcp.json and mcp.json', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, '.mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });
    write(pluginDir, 'mcp.json', { mcpServers: { 'server-b': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['claude', 'kiro']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('mcp-key-sync');
    expect(findings[0]?.message).toContain('server-a');
    expect(findings[0]?.message).toContain('server-b');
  });

  it('returns no findings when only claude is in the envelope (no cross-target compare)', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, '.mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['claude']);
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when only kiro is in the envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, 'mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['kiro']);
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when both files are empty mcpServers', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, '.mcp.json', { mcpServers: {} });
    write(pluginDir, 'mcp.json', { mcpServers: {} });

    const findings = validateMcpKeySync(pluginDir, ['claude', 'kiro']);
    expect(findings).toHaveLength(0);
  });

  it('skips the check when .mcp.json is missing', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, 'mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['claude', 'kiro']);
    expect(findings).toHaveLength(0);
  });

  it('works when cursor (not claude) plus kiro triggers the check', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    write(pluginDir, '.mcp.json', { mcpServers: { 'server-a': { command: 'node' } } });
    write(pluginDir, 'mcp.json', { mcpServers: { 'server-b': { command: 'node' } } });

    const findings = validateMcpKeySync(pluginDir, ['cursor', 'kiro']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('mcp-key-sync');
  });
});

// ---------------------------------------------------------------------------
// validateMarketplaceRegistration
// ---------------------------------------------------------------------------

describe('validateMarketplaceRegistration()', () => {
  it('returns no findings when plugin is registered in both marketplaces and both targets in envelope', () => {
    const repoRoot = createRepoRoot(tmpDir, ['skill-evaluator']);
    const pluginDir = path.join(repoRoot, 'plugins', 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude', 'cursor']);
    expect(findings).toHaveLength(0);
  });

  it('emits marketplace-registration when plugin is registered but claude is not in envelope', () => {
    const repoRoot = createRepoRoot(tmpDir, ['skill-evaluator']);
    const pluginDir = path.join(repoRoot, 'plugins', 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['cursor']); // no claude
    expect(
      findings.some((f) => f.code === 'marketplace-registration' && f.message.includes('claude')),
    ).toBe(true);
  });

  it('emits marketplace-registration when plugin is not registered but claude is in envelope', () => {
    const repoRoot = createRepoRoot(tmpDir, []); // no plugins registered
    const pluginDir = path.join(repoRoot, 'plugins', 'unknown-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude']);
    expect(
      findings.some(
        (f) => f.code === 'marketplace-registration' && f.message.includes('unknown-plugin'),
      ),
    ).toBe(true);
  });

  it('emits marketplace-registration when marketplace.json is missing and cursor is in envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo-no-marketplace');
    fs.mkdirSync(repoRoot, { recursive: true });
    // No marketplace files created

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['cursor']);
    expect(
      findings.some((f) => f.code === 'marketplace-registration' && f.message.includes('cursor')),
    ).toBe(true);
  });

  it('returns no findings when marketplace.json is missing and target is not in envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo-no-marketplace');
    fs.mkdirSync(repoRoot, { recursive: true });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['gemini']);
    expect(findings).toHaveLength(0);
  });

  it('emits marketplace-registration when source has wrong path', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
    // Register with wrong source
    write(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'test',
      owner: { name: 'Test' },
      plugins: [{ name: 'my-plugin', source: './plugins/wrong-dir' }],
    });
    write(repoRoot, '.cursor-plugin/marketplace.json', {
      name: 'test',
      owner: { name: 'Test' },
      plugins: [],
    });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude']);
    expect(
      findings.some(
        (f) => f.code === 'marketplace-registration' && f.message.includes('wrong-dir'),
      ),
    ).toBe(true);
  });

  it('accepts source without leading "./" (normalised equivalent)', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const pluginDir = path.join(repoRoot, 'plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    // Source without leading "./"
    write(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'test',
      owner: { name: 'Test' },
      plugins: [{ name: 'my-plugin', source: 'plugins/my-plugin' }],
    });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude']);
    // Should not emit a finding — normalised paths match
    expect(findings.filter((f) => f.code === 'marketplace-registration')).toHaveLength(0);
  });

  it('expects the source to match a relocated pluginsRoot (embedded marketplace)', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    // Embedded layout: the plugin lives under a relocated `agent-plugins/` root.
    const pluginDir = path.join(repoRoot, 'agent-plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    write(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'test',
      owner: { name: 'Test' },
      plugins: [{ name: 'my-plugin', source: './agent-plugins/my-plugin' }],
    });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude']);
    expect(findings.filter((f) => f.code === 'marketplace-registration')).toHaveLength(0);
  });

  it('emits marketplace-registration when a relocated plugin still registers the old ./plugins/ source', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const pluginDir = path.join(repoRoot, 'agent-plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    write(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'test',
      owner: { name: 'Test' },
      plugins: [{ name: 'my-plugin', source: './plugins/my-plugin' }],
    });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude']);
    expect(
      findings.some(
        (f) =>
          f.code === 'marketplace-registration' && f.message.includes('./agent-plugins/my-plugin'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateMarketplaceRegistration — Codex object-source registry
//
// Codex's repo marketplace lives at `.agents/plugins/marketplace.json` and its plugin entries
// use an OBJECT source (`source: { source, path }`) rather than the string source Claude/Cursor
// use. The comparable path lives at `source.path`. These tests mirror the string-source ones.
//
// @see https://developers.openai.com/codex/plugins/build
// ---------------------------------------------------------------------------

describe('validateMarketplaceRegistration() — codex object source', () => {
  const CODEX_MARKETPLACE_REL = '.agents/plugins/marketplace.json';

  /** Write a Codex object-source marketplace listing the given plugin entries. */
  function writeCodexMarketplace(
    repoRoot: string,
    entries: { name: string; path: string }[],
  ): void {
    write(repoRoot, CODEX_MARKETPLACE_REL, {
      name: 'test-marketplace',
      interface: { displayName: 'Test Marketplace' },
      plugins: entries.map((e) => ({
        name: e.name,
        source: { source: 'local', path: e.path },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      })),
    });
  }

  it('returns no findings when a correctly-registered codex plugin is in the envelope', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const pluginDir = path.join(repoRoot, 'plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    writeCodexMarketplace(repoRoot, [{ name: 'my-plugin', path: './plugins/my-plugin' }]);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(findings.filter((f) => f.code === 'marketplace-registration')).toHaveLength(0);
  });

  it('accepts source.path without leading "./" (normalised equivalent)', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const pluginDir = path.join(repoRoot, 'plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    writeCodexMarketplace(repoRoot, [{ name: 'my-plugin', path: 'plugins/my-plugin' }]);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(findings.filter((f) => f.code === 'marketplace-registration')).toHaveLength(0);
  });

  it('emits marketplace-registration when the codex marketplace file is missing', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo-empty');
    fs.mkdirSync(repoRoot, { recursive: true });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(
      findings.some((f) => f.code === 'marketplace-registration' && f.message.includes('codex')),
    ).toBe(true);
  });

  it('emits marketplace-registration when the plugin is not listed but codex is in the envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
    writeCodexMarketplace(repoRoot, []); // no entries

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(
      findings.some(
        (f) => f.code === 'marketplace-registration' && f.message.includes('not listed'),
      ),
    ).toBe(true);
  });

  it('emits marketplace-registration when source.path is wrong', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
    writeCodexMarketplace(repoRoot, [{ name: 'my-plugin', path: './plugins/wrong-dir' }]);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(
      findings.some(
        (f) => f.code === 'marketplace-registration' && f.message.includes('wrong-dir'),
      ),
    ).toBe(true);
  });

  it('emits marketplace-registration when source is a STRING instead of the expected object', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
    // String source does not match the Codex object-source schema → parse-error → not-listed-style
    // failure is surfaced as a parse failure finding while codex is in the envelope.
    write(repoRoot, CODEX_MARKETPLACE_REL, {
      name: 'test-marketplace',
      plugins: [{ name: 'my-plugin', source: './plugins/my-plugin' }],
    });

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['codex']);
    expect(findings.some((f) => f.code === 'marketplace-registration')).toBe(true);
  });

  it('emits marketplace-registration when the plugin is listed but codex is NOT in the envelope', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
    writeCodexMarketplace(repoRoot, [{ name: 'my-plugin', path: './plugins/my-plugin' }]);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['gemini']);
    expect(
      findings.some(
        (f) => f.code === 'marketplace-registration' && f.message.includes('not in the support'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCrossTarget
// ---------------------------------------------------------------------------

describe('validateCrossTarget()', () => {
  it('collects findings from all validators without short-circuiting', () => {
    const pluginDir = path.join(tmpDir, 'bar');
    // claude in envelope — missing .claude-plugin/plugin.json (adherence)
    // gemini artifact present but not in envelope (adherence)
    // kiro POWER.md has wrong name (name-consistency)
    write(pluginDir, 'gemini-extension.json', { name: 'bar' });
    write(
      pluginDir,
      'POWER.md',
      frontmatter({ name: 'wrong', description: 'test', version: '0.0.1' }),
    );
    write(pluginDir, 'mcp.json', { mcpServers: {} });
    const repoRoot = createRepoRoot(tmpDir, ['bar']);

    const findings = validateCrossTarget(pluginDir, repoRoot, ['claude', 'kiro']);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('envelope-adherence');
    expect(codes).toContain('name-consistency');
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for a fully correct plugin', () => {
    const repoRoot = createRepoRoot(tmpDir, ['my-plugin']);
    // The plugin lives under the repo's plugins/ root, matching the registered source.
    const pluginDir = path.join(repoRoot, 'plugins', 'my-plugin');
    // Include cursor so both marketplace files match the envelope
    createMinimalPlugin(pluginDir, 'my-plugin', ['claude', 'cursor', 'kiro']);

    const findings = validateCrossTarget(pluginDir, repoRoot, ['claude', 'cursor', 'kiro']);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parity test — real skill-evaluator plugin
// ---------------------------------------------------------------------------

describe.skipIf(!TEMPLATE_REPO_AVAILABLE)('parity: real skill-evaluator plugin', () => {
  const SKILL_EVALUATOR_SRC = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

  /**
   * Copy a directory tree recursively.
   */
  function copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  it('produces zero findings for the canonical skill-evaluator plugin with all targets', () => {
    // Set up a temp repo root that mirrors the template layout
    const repoRoot = path.join(tmpDir, 'repo');
    const pluginsDir = path.join(repoRoot, 'plugins');
    const pluginDir = path.join(pluginsDir, 'skill-evaluator');

    // Copy the real skill-evaluator plugin
    copyDir(SKILL_EVALUATOR_SRC, pluginDir);

    // Copy both real marketplace files
    copyDir(path.join(TEMPLATE_REPO, '.claude-plugin'), path.join(repoRoot, '.claude-plugin'));
    copyDir(path.join(TEMPLATE_REPO, '.cursor-plugin'), path.join(repoRoot, '.cursor-plugin'));

    // The skill-evaluator supports all five targets; its skills/ directory satisfies vercel
    const envelope: readonly ['claude', 'cursor', 'gemini', 'kiro', 'vercel'] = [
      'claude',
      'cursor',
      'gemini',
      'kiro',
      'vercel',
    ];

    const findings = validateCrossTarget(pluginDir, repoRoot, envelope);

    if (findings.length > 0) {
      const details = findings.map((f) => `  [${f.code}] ${f.message}`).join('\n');
      throw new Error(`Expected zero findings but got ${String(findings.length)}:\n${details}`);
    }
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkDefaultMarketplaceName
// ---------------------------------------------------------------------------

describe('checkDefaultMarketplaceName()', () => {
  /** Write a repo-root registry carrying the given top-level marketplace metadata. */
  function writeNamedRegistry(
    repoRoot: string,
    rel: string,
    metadata: { name?: string; owner?: { name: string } },
  ): void {
    write(repoRoot, rel, { ...metadata, plugins: [] });
  }

  it('emits a SOFT finding when the workspace marketplace name is the upstream default', () => {
    const workspace = defineWorkspace({ marketplace: { name: 'ai-plugin-marketplace' } });
    const findings = checkDefaultMarketplaceName(tmpDir, workspace);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('default-marketplace-name');
    expect(findings[0]?.severity).toBe('soft');
    expect(findings[0]?.hint).toBeDefined();
  });

  it('emits a SOFT finding for the my-ai-plugins placeholder name', () => {
    const workspace = defineWorkspace({ marketplace: { name: 'my-ai-plugins' } });
    const findings = checkDefaultMarketplaceName(tmpDir, workspace);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('soft');
  });

  it('emits a SOFT finding when the owner name is a template default', () => {
    const workspace = defineWorkspace({
      marketplace: { name: 'acme-ai-plugins', owner: { name: 'Your Name' } },
    });
    const findings = checkDefaultMarketplaceName(tmpDir, workspace);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('default-marketplace-name');
    expect(findings[0]?.message).toContain('owner');
  });

  it('emits two findings when both name and owner are template defaults', () => {
    const workspace = defineWorkspace({
      marketplace: {
        name: 'ai-plugin-marketplace',
        owner: { name: 'AI Plugin Marketplace Template' },
      },
    });
    const findings = checkDefaultMarketplaceName(tmpDir, workspace);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'soft')).toBe(true);
  });

  it('emits no finding for a custom marketplace name (workspace)', () => {
    const workspace = defineWorkspace({
      marketplace: { name: 'acme-ai-plugins', owner: { name: 'Acme Corp' } },
    });
    expect(checkDefaultMarketplaceName(tmpDir, workspace)).toHaveLength(0);
  });

  it('reads the effective name from a repo-root registry when no workspace exists', () => {
    const repoRoot = path.join(tmpDir, 'registry-only');
    writeNamedRegistry(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'my-ai-plugins',
      owner: { name: 'my-ai-plugins' },
    });
    const findings = checkDefaultMarketplaceName(repoRoot, undefined);
    expect(findings.some((f) => f.code === 'default-marketplace-name')).toBe(true);
    expect(findings.every((f) => f.severity === 'soft')).toBe(true);
  });

  it('emits no finding for a custom name in a repo-root registry (no workspace)', () => {
    const repoRoot = path.join(tmpDir, 'registry-custom');
    writeNamedRegistry(repoRoot, '.claude-plugin/marketplace.json', {
      name: 'acme-ai-plugins',
      owner: { name: 'Acme Corp' },
    });
    expect(checkDefaultMarketplaceName(repoRoot, undefined)).toHaveLength(0);
  });

  it('emits nothing when no marketplace metadata is declared at all', () => {
    // A bare `{ plugins: [] }` registry (or no registry) carries no identity — emit nothing.
    const repoRoot = path.join(tmpDir, 'no-metadata');
    write(repoRoot, '.claude-plugin/marketplace.json', { plugins: [] });
    expect(checkDefaultMarketplaceName(repoRoot, undefined)).toHaveLength(0);
    expect(checkDefaultMarketplaceName(path.join(tmpDir, 'nonexistent'), undefined)).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// validateFrontmatterParses
// ---------------------------------------------------------------------------

describe('validateFrontmatterParses()', () => {
  // Frontmatter must be valid YAML for strict hosts (e.g. Codex's skill loader), not only
  // Claude's lenient parser. @see https://yaml.org/spec/1.2.2/#732-block-mappings
  let tmp: string;
  beforeEach(() => {
    tmp = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Create a plugin dir named 'demo' containing one file. Returns its absolute dir. */
  function pluginWith(rel: string, content: string): string {
    const dir = path.join(tmp, 'plugins', 'demo');
    write(dir, rel, content);
    return dir;
  }

  it('returns no findings when all frontmatter parses as YAML', () => {
    const dir = pluginWith(
      'skills/demo/SKILL.md',
      frontmatter({ name: 'demo', description: 'Plain description with no colon' }),
    );
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
  });

  it('emits a hard frontmatter-invalid finding for an unquoted colon-space in a description', () => {
    // The real defect: an unquoted `description: ... acts as a liaison: it syncs ...` —
    // YAML reads the inner ': ' as an illegal nested mapping, so strict hosts fail to load it.
    const dir = pluginWith(
      'skills/liaison/SKILL.md',
      frontmatter({
        name: 'liaison',
        description: 'A skill that acts as a liaison: it syncs docs',
      }),
    );
    const findings = validateFrontmatterParses(dir, 'demo');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'frontmatter-invalid',
      plugin: 'demo',
    });
    // Message names the offending file so the author can find it.
    expect(findings[0]?.message).toContain(path.join('skills', 'liaison', 'SKILL.md'));
    expect(findings[0]?.hint).toBeDefined();
  });

  it('accepts the same value once it is quoted (the fix)', () => {
    const dir = pluginWith(
      'skills/liaison/SKILL.md',
      frontmatter({
        name: 'liaison',
        description: '"A skill that acts as a liaison: it syncs docs"',
      }),
    );
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
  });

  it('checks POWER.md frontmatter', () => {
    const dir = pluginWith(
      'POWER.md',
      frontmatter({ name: 'demo', description: 'bad: nested mapping here' }),
    );
    const findings = validateFrontmatterParses(dir, 'demo');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('POWER.md');
  });

  it('checks agents/*.md frontmatter', () => {
    const dir = pluginWith(
      'agents/reviewer.md',
      frontmatter({ name: 'reviewer', description: 'agent that does: a thing' }),
    );
    const findings = validateFrontmatterParses(dir, 'demo');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(path.join('agents', 'reviewer.md'));
  });

  it('ignores a markdown file that has no frontmatter block', () => {
    const dir = pluginWith('skills/demo/SKILL.md', '# Just a heading, no frontmatter\n');
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
  });

  it('returns no findings for a plugin with no frontmatter-bearing files', () => {
    const dir = path.join(tmp, 'plugins', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
  });

  it('does not mistake a body --- thematic break for frontmatter', () => {
    // No leading frontmatter; the body just uses --- as a horizontal rule. The matcher is
    // anchored to the start of the file, so this must not be parsed as YAML (no false positive).
    const dir = pluginWith(
      'skills/demo/SKILL.md',
      '# Title\n\nIntro.\n\n---\n\nkey: value: not actually frontmatter\n\n---\n\nMore.\n',
    );
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
  });

  it('detects and parses CRLF-delimited frontmatter (Windows checkouts)', () => {
    const dir = pluginWith(
      'skills/ok/SKILL.md',
      '---\r\nname: ok\r\ndescription: fine\r\n---\r\n\r\n# Body\r\n',
    );
    expect(validateFrontmatterParses(dir, 'demo')).toEqual([]);
    // A CRLF frontmatter with a colon-space defect is still detected and reported.
    write(dir, 'skills/bad/SKILL.md', '---\r\nname: bad\r\ndescription: broken: here\r\n---\r\n');
    const findings = validateFrontmatterParses(dir, 'demo');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(path.join('skills', 'bad', 'SKILL.md'));
  });

  it('reports every malformed file without short-circuiting', () => {
    const dir = pluginWith(
      'skills/a/SKILL.md',
      frontmatter({ name: 'a', description: 'broken: here' }),
    );
    write(dir, 'skills/b/SKILL.md', frontmatter({ name: 'b', description: 'also broken: here' }));
    const findings = validateFrontmatterParses(dir, 'demo');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === 'frontmatter-invalid' && f.severity === 'hard')).toBe(
      true,
    );
  });
});

describe('runValidate() — plugin-shaped repo-root subdirectory missing aipm.config.ts (#91)', () => {
  it('reports envelope-invalid for a plugins/* dir with a target manifest but no aipm.config.ts', async () => {
    const tmp = makeTempDir();
    const repoRoot = path.join(tmp, 'repo');
    // Repro shape from #91: `mv p/aipm.config.ts aside` — target manifest still present.
    write(repoRoot, 'plugins/broken/.claude-plugin/plugin.json', {
      name: 'broken',
      version: '0.1.0',
    });

    const result = await runValidate(repoRoot);

    const envelopeFindings = result.findings.filter((f) => f.code === 'envelope-invalid');
    expect(envelopeFindings).toHaveLength(1);
    expect(envelopeFindings[0]?.plugin).toBe('broken');
    expect(envelopeFindings[0]?.severity).toBe('hard');
    expect(envelopeFindings[0]?.message).toContain('aipm.config.ts');
    expect(result.passed).toBe(false);
  });

  it('reports envelope-invalid for a plugins/* dir with a skill but no aipm.config.ts', async () => {
    const tmp = makeTempDir();
    const repoRoot = path.join(tmp, 'repo');
    write(repoRoot, 'plugins/broken/skills/my-skill/SKILL.md', frontmatter({ name: 'my-skill' }));

    const result = await runValidate(repoRoot);

    const envelopeFindings = result.findings.filter((f) => f.code === 'envelope-invalid');
    expect(envelopeFindings).toHaveLength(1);
    expect(envelopeFindings[0]?.plugin).toBe('broken');
    expect(result.passed).toBe(false);
  });

  it('does not report a finding for a plugins/* dir with no plugin-shape marker at all', async () => {
    const tmp = makeTempDir();
    const repoRoot = path.join(tmp, 'repo');
    write(repoRoot, 'plugins/not-a-plugin/README.md', '# Notes\n');

    const result = await runValidate(repoRoot);

    expect(result.findings).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });
});
