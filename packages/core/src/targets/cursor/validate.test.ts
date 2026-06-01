/**
 * Tests for the Cursor per-target validator.
 *
 * Covers:
 *   - Manifest file-ref resolution (skills dirs, agents .md files, commands)
 *   - Path safety checks (./ prefix, no .. traversal)
 *   - Cursor rule frontmatter validation against cursorRuleFrontmatterSchema
 *   - Parity test: real skill-evaluator plugin produces zero findings
 *
 * @see packages/core/docs/specs/architecture.md §10 (validation contract)
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/plugins/skill-evaluator/.cursor-plugin/plugin.json
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_REPO, TEMPLATE_REPO_AVAILABLE } from '../../test-support/template-repo.js';
import { validateCursorPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-validate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a file at `<tmpDir>/<relPath>`, creating parent directories as needed.
 */
function writeFile(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/**
 * Create an empty directory at `<tmpDir>/<relPath>`.
 */
function mkdir(relPath: string): void {
  fs.mkdirSync(path.join(tmpDir, relPath), { recursive: true });
}

/**
 * Write a minimal valid .cursor-plugin/plugin.json.
 */
function writeManifest(overrides: Record<string, unknown> = {}): void {
  writeFile(
    '.cursor-plugin/plugin.json',
    JSON.stringify({ name: 'test-plugin', ...overrides }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Positive: valid manifest and rules → zero findings
// ---------------------------------------------------------------------------

describe('validateCursorPlugin — positive cases', () => {
  it('returns zero findings for a plugin with no manifest and no rules', () => {
    // No .cursor-plugin/plugin.json or rules/ dir — validator silently skips
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a valid manifest with no file refs', () => {
    writeManifest();
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a valid manifest with all file refs resolving', () => {
    mkdir('skills/my-skill');
    writeFile('agents/assistant.md', '# Agent');
    writeFile('commands/run.md', '# Command');
    writeManifest({
      skills: ['./skills/my-skill'],
      agents: ['./agents/assistant.md'],
      commands: ['./commands/run.md'],
    });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a .mdc file with no frontmatter block', () => {
    writeManifest();
    writeFile('rules/plain-rule.mdc', '# Just markdown content\n\nNo frontmatter here.');
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a .mdc file with valid frontmatter', () => {
    writeManifest();
    writeFile(
      'rules/valid-rule.mdc',
      '---\ndescription: My rule\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n---\n\nContent here.',
    );
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a manifest referencing a string skills path', () => {
    mkdir('skills/single-skill');
    writeManifest({ skills: './skills/single-skill' });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative: manifest file-ref failures → schema-invalid
// ---------------------------------------------------------------------------

describe('validateCursorPlugin — manifest file-ref failures', () => {
  it('emits schema-invalid when a skills ref does not exist on disk', () => {
    writeManifest({ skills: ['./skills/missing'] });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/skills.*non-existent/i);
  });

  it('emits schema-invalid when a skills ref points to a file instead of a directory', () => {
    writeFile('skills/not-a-dir.md', '# File, not a directory');
    writeManifest({ skills: ['./skills/not-a-dir.md'] });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/must be a directory/i);
  });

  it('emits schema-invalid when a path contains ".." segments', () => {
    writeManifest({ skills: ['./skills/../../../etc'] });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/must not contain "\.\."/i);
  });

  it('emits schema-invalid when agents ref does not exist', () => {
    writeManifest({ agents: ['./agents/missing.md'] });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/agents.*non-existent/i);
  });

  it('emits schema-invalid when agents ref points to a directory instead of a file', () => {
    mkdir('agents/a-directory.md');
    writeManifest({ agents: ['./agents/a-directory.md'] });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/must be a file/i);
  });

  it('emits one finding per broken ref when multiple are broken', () => {
    writeManifest({
      skills: ['./skills/missing-one', './skills/missing-two'],
    });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.code).toBe('schema-invalid');
    }
  });

  it('does NOT emit a finding for a hooks string ref (hooks are excluded from Cursor ref checks)', () => {
    // hooks/claude.json is a Claude-generated file; its absence is not a Cursor violation
    writeManifest({ hooks: './hooks/claude.json' });
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative: .mdc frontmatter failures → schema-invalid
// ---------------------------------------------------------------------------

describe('validateCursorPlugin — .mdc frontmatter failures', () => {
  it('emits schema-invalid when .mdc frontmatter has wrong type on alwaysApply', () => {
    writeManifest();
    // alwaysApply must be boolean; passing a string fails cursorRuleFrontmatterSchema
    writeFile(
      'rules/bad-rule.mdc',
      '---\ndescription: A rule\nalwaysApply: "yes-not-a-boolean"\n---\n\nContent.',
    );
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/frontmatter failed schema validation/i);
  });

  it('emits schema-invalid when .mdc frontmatter has wrong type on globs (not an array)', () => {
    writeManifest();
    writeFile('rules/bad-globs.mdc', '---\ndescription: Rule\nglobs: "**/*.ts"\n---\n\nContent.');
    const findings = validateCursorPlugin(tmpDir);
    // globs must be string[] — a plain string should fail
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('schema-invalid');
  });

  it('does NOT emit a finding when .mdc has no frontmatter', () => {
    writeManifest();
    writeFile('rules/no-fm.mdc', '# Rule without frontmatter\n\nJust content.');
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('does NOT emit a finding when rules/ dir does not exist', () => {
    writeManifest();
    // No rules/ directory
    const findings = validateCursorPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: parity test — real skill-evaluator plugin → zero findings
// ---------------------------------------------------------------------------

describe.skipIf(!TEMPLATE_REPO_AVAILABLE)('validateCursorPlugin — skill-evaluator parity', () => {
  it('produces zero findings for the real skill-evaluator plugin', () => {
    const pluginDir = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

    if (!fs.existsSync(pluginDir)) {
      // The template repo is a sibling repo; skip gracefully if not checked out.
      console.warn(
        `Parity test skipped: skill-evaluator not found at ${pluginDir}. ` +
          'Clone ai-plugin-marketplace-template as a sibling directory to run this test.',
      );
      return;
    }

    const findings = validateCursorPlugin(pluginDir);
    expect(findings).toHaveLength(0);
  });
});
