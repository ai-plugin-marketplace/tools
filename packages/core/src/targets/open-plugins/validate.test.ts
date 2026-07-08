/**
 * Tests for the Open Plugins per-target validator.
 *
 * Covers:
 *   - Manifest schema rejection (bad name → schema-invalid)
 *   - Manifest file-ref resolution for declared component paths
 *   - Metadata-dir isolation: `.plugin/` must contain only plugin.json (spec §2.1)
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see docs/specs/architecture.md §10 (validation contract)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveContainedPath, validateOpenPluginsPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-plugins-validate-test-'));
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

/** Write a minimal valid `.plugin/plugin.json`. */
function writeManifest(overrides: Record<string, unknown> = {}): void {
  writeFile('.plugin/plugin.json', JSON.stringify({ name: 'test-plugin', ...overrides }, null, 2));
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('validateOpenPluginsPlugin — positive cases', () => {
  it('returns zero findings for a plugin with no manifest', () => {
    expect(validateOpenPluginsPlugin(tmpDir)).toHaveLength(0);
  });

  it('returns zero findings for a valid manifest with no component refs', () => {
    writeManifest();
    expect(validateOpenPluginsPlugin(tmpDir)).toHaveLength(0);
  });

  it('returns zero findings when every declared component path resolves', () => {
    mkdir('commands');
    mkdir('skills/my-skill');
    writeFile('agents/assistant.md', '# Agent');
    writeManifest({
      commands: './commands',
      skills: ['./skills/my-skill'],
      agents: ['./agents/assistant.md'],
    });
    expect(validateOpenPluginsPlugin(tmpDir)).toHaveLength(0);
  });

  it('accepts the { paths } object form when the paths resolve', () => {
    mkdir('output-styles');
    writeManifest({ outputStyles: { paths: ['./output-styles'] } });
    expect(validateOpenPluginsPlugin(tmpDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema failures → schema-invalid
// ---------------------------------------------------------------------------

describe('validateOpenPluginsPlugin — schema failures', () => {
  it('emits schema-invalid for an invalid plugin name', () => {
    writeFile('.plugin/plugin.json', JSON.stringify({ name: 'Bad Name' }, null, 2));
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/failed schema validation/i);
  });

  it('emits schema-invalid for malformed JSON', () => {
    writeFile('.plugin/plugin.json', '{ not valid json');
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/not valid JSON/i);
  });

  it('emits schema-invalid for a non-"./"-relative component path', () => {
    writeManifest({ commands: 'commands' });
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('schema-invalid');
  });
});

// ---------------------------------------------------------------------------
// Missing declared component file → schema-invalid
// ---------------------------------------------------------------------------

describe('validateOpenPluginsPlugin — missing component refs', () => {
  it('emits schema-invalid when a declared component file does not exist on disk', () => {
    writeManifest({ agents: ['./agents/missing.md'] });
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'hard',
      code: 'schema-invalid',
      plugin: path.basename(tmpDir),
    });
    expect(findings[0]?.message).toMatch(/agents.*non-existent/i);
  });

  it('emits one finding per missing ref when multiple are broken', () => {
    writeManifest({ skills: ['./skills/one', './skills/two'] });
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings).toHaveLength(2);
    for (const f of findings) expect(f.code).toBe('schema-invalid');
  });
});

// ---------------------------------------------------------------------------
// Metadata-dir isolation → metadata-dir-isolation (spec §2.1)
// ---------------------------------------------------------------------------

describe('validateOpenPluginsPlugin — metadata-dir isolation', () => {
  it('emits a hard metadata-dir-isolation finding when .plugin/ holds an extra file', () => {
    writeManifest();
    writeFile('.plugin/extra.txt', 'stray');
    const findings = validateOpenPluginsPlugin(tmpDir);
    const isolation = findings.filter((f) => f.code === 'metadata-dir-isolation');
    expect(isolation).toHaveLength(1);
    expect(isolation[0]).toMatchObject({
      severity: 'hard',
      code: 'metadata-dir-isolation',
      plugin: path.basename(tmpDir),
    });
    expect(isolation[0]?.message).toMatch(/extra\.txt/);
  });

  it('emits metadata-dir-isolation when .plugin/ holds an extra subdirectory', () => {
    writeManifest();
    mkdir('.plugin/nested');
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings.filter((f) => f.code === 'metadata-dir-isolation')).toHaveLength(1);
  });

  it('does NOT emit metadata-dir-isolation when .plugin/ holds only plugin.json', () => {
    writeManifest();
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings.filter((f) => f.code === 'metadata-dir-isolation')).toHaveLength(0);
  });

  it('does NOT emit metadata-dir-isolation when .plugin/ is absent', () => {
    const findings = validateOpenPluginsPlugin(tmpDir);
    expect(findings.filter((f) => f.code === 'metadata-dir-isolation')).toHaveLength(0);
  });

  // Regression (PR #28 review): a readdir failure was swallowed, so `.plugin` existing as a FILE
  // (ENOTDIR) silently passed the isolation check instead of being reported.
  it('emits metadata-dir-isolation when .plugin exists but is a file, not a directory', () => {
    writeFile('.plugin', '{"name": "not-a-dir"}');
    const findings = validateOpenPluginsPlugin(tmpDir);
    const isolation = findings.filter((f) => f.code === 'metadata-dir-isolation');
    expect(isolation).toHaveLength(1);
    expect(isolation[0]).toMatchObject({ severity: 'hard' });
    expect(isolation[0]?.message).toMatch(/not a directory/);
  });
});

// ---------------------------------------------------------------------------
// resolveContainedPath — defense-in-depth containment (PR #28 review)
// ---------------------------------------------------------------------------

// The manifest schema already rejects these shapes; the validator re-verifies containment at the
// filesystem boundary so the two layers cannot drift. Exercised directly with hostile inputs.
describe('resolveContainedPath', () => {
  it('resolves a well-formed "./"-relative path inside the plugin dir', () => {
    expect(resolveContainedPath(tmpDir, './commands')).toBe(path.join(tmpDir, 'commands'));
  });

  it('returns undefined for parent traversal: "./.."', () => {
    expect(resolveContainedPath(tmpDir, './..')).toBeUndefined();
  });

  it('returns undefined for nested traversal escaping the root: "./a/../../b"', () => {
    expect(resolveContainedPath(tmpDir, './a/../../b')).toBeUndefined();
  });

  it('returns undefined for backslash-separated traversal: "./a\\..\\b"', () => {
    expect(resolveContainedPath(tmpDir, './a\\..\\b')).toBeUndefined();
  });

  it('returns undefined for an absolute path', () => {
    expect(resolveContainedPath(tmpDir, os.tmpdir())).toBeUndefined();
  });

  it('does not treat a sibling directory sharing the prefix as contained', () => {
    // `<tmpDir>-evil` starts with the same characters as `<tmpDir>` but is outside it.
    expect(resolveContainedPath(tmpDir, `../${path.basename(tmpDir)}-evil`)).toBeUndefined();
  });

  it('resolves "." to the plugin root itself', () => {
    expect(resolveContainedPath(tmpDir, '.')).toBe(path.resolve(tmpDir));
  });
});
