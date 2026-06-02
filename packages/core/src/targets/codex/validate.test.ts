/**
 * Tests for the Codex per-target validator.
 *
 * Covers:
 *   - Manifest file-ref resolution (skills dirs, agents .md files, commands)
 *   - Path safety checks (./ prefix, no .. traversal)
 *   - Schema rejection of an invalid manifest (bad name)
 *   - Hooks/apps refs excluded from Codex ref checks (out of scope for v0.1.0)
 *
 * @see https://developers.openai.com/codex/plugins/build
 * @see packages/core/docs/specs/architecture.md §10 (validation contract)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCodexPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-validate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file at `<tmpDir>/<relPath>`, creating parent directories as needed. */
function writeFile(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Create an empty directory at `<tmpDir>/<relPath>`. */
function mkdir(relPath: string): void {
  fs.mkdirSync(path.join(tmpDir, relPath), { recursive: true });
}

/** Write a minimal valid .codex-plugin/plugin.json. */
function writeManifest(overrides: Record<string, unknown> = {}): void {
  writeFile(
    '.codex-plugin/plugin.json',
    JSON.stringify({ name: 'test-plugin', ...overrides }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Positive: valid manifest → zero findings
// ---------------------------------------------------------------------------

describe('validateCodexPlugin — positive cases', () => {
  it('returns zero findings for a plugin with no manifest', () => {
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a valid manifest with no file refs', () => {
    writeManifest();
    const findings = validateCodexPlugin(tmpDir);
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
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('returns zero findings for a manifest referencing a string skills path', () => {
    mkdir('skills/single-skill');
    writeManifest({ skills: './skills/single-skill' });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative: schema failures → schema-invalid
// ---------------------------------------------------------------------------

describe('validateCodexPlugin — schema failures', () => {
  it('emits schema-invalid for an invalid plugin name', () => {
    writeFile('.codex-plugin/plugin.json', JSON.stringify({ name: 'Bad Name' }, null, 2));
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/failed schema validation/i);
  });

  it('emits schema-invalid for malformed JSON', () => {
    writeFile('.codex-plugin/plugin.json', '{ not valid json');
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/not valid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// Negative: manifest file-ref failures → schema-invalid
// ---------------------------------------------------------------------------

describe('validateCodexPlugin — manifest file-ref failures', () => {
  it('emits schema-invalid when a skills ref does not exist on disk', () => {
    writeManifest({ skills: ['./skills/missing'] });
    const findings = validateCodexPlugin(tmpDir);
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
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/must be a directory/i);
  });

  it('emits schema-invalid when a path contains ".." segments', () => {
    writeManifest({ skills: ['./skills/../../../etc'] });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/must not contain "\.\."/i);
  });

  it('emits schema-invalid when agents ref does not exist', () => {
    writeManifest({ agents: ['./agents/missing.md'] });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/agents.*non-existent/i);
  });

  it('emits schema-invalid when agents ref points to a directory instead of a file', () => {
    mkdir('agents/a-directory.md');
    writeManifest({ agents: ['./agents/a-directory.md'] });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/must be a file/i);
  });

  it('emits one finding per broken ref when multiple are broken', () => {
    writeManifest({ skills: ['./skills/missing-one', './skills/missing-two'] });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.code).toBe('schema-invalid');
    }
  });

  it('does NOT emit a finding for a hooks string ref (hooks are excluded from Codex ref checks)', () => {
    writeManifest({ hooks: './hooks/hooks.json' });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });

  it('does NOT emit a finding for an apps string ref (apps are excluded from Codex ref checks)', () => {
    writeManifest({ apps: './apps/' });
    const findings = validateCodexPlugin(tmpDir);
    expect(findings).toHaveLength(0);
  });
});
