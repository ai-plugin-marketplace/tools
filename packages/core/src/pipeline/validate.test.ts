/**
 * Tests for the cross-target validator pipeline module.
 *
 * @see docs/specs/architecture.md §10.1 (validation contract), §6 (support envelope), §4.4 (marketplace registry)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_REPO } from '../test-support/template-repo.js';
import {
  validateCrossTarget,
  validateEnvelopeAdherence,
  validateEnvelopeShape,
  validateMarketplaceRegistration,
  validateMcpKeySync,
  validateNameConsistency,
} from './validate.js';

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
    const pluginDir = path.join(tmpDir, 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = createRepoRoot(tmpDir, ['skill-evaluator']);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['claude', 'cursor']);
    expect(findings).toHaveLength(0);
  });

  it('emits marketplace-registration when plugin is registered but claude is not in envelope', () => {
    const pluginDir = path.join(tmpDir, 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = createRepoRoot(tmpDir, ['skill-evaluator']);

    const findings = validateMarketplaceRegistration(pluginDir, repoRoot, ['cursor']); // no claude
    expect(
      findings.some((f) => f.code === 'marketplace-registration' && f.message.includes('claude')),
    ).toBe(true);
  });

  it('emits marketplace-registration when plugin is not registered but claude is in envelope', () => {
    const pluginDir = path.join(tmpDir, 'unknown-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = createRepoRoot(tmpDir, []); // no plugins registered

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
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const repoRoot = path.join(tmpDir, 'repo');
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
    const pluginDir = path.join(tmpDir, 'my-plugin');
    // Include cursor so both marketplace files match the envelope
    createMinimalPlugin(pluginDir, 'my-plugin', ['claude', 'cursor', 'kiro']);
    const repoRoot = createRepoRoot(tmpDir, ['my-plugin']);

    const findings = validateCrossTarget(pluginDir, repoRoot, ['claude', 'cursor', 'kiro']);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parity test — real skill-evaluator plugin
// ---------------------------------------------------------------------------

describe('parity: real skill-evaluator plugin', () => {
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
