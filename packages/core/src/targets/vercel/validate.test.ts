/**
 * Tests for the Vercel Skills CLI per-target validator.
 *
 * Fixtures are built programmatically in OS temp directories. The parity test
 * uses the real `skill-evaluator` plugin from the template repo to verify zero
 * findings against a production example.
 *
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding, FindingCode types)
 * @see https://agentskills.io (name/description constraints)
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/plugins/skill-evaluator/
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMPLATE_REPO } from '../../test-support/template-repo.js';
import { validateVercelPlugin } from './validate.js';

// ---------------------------------------------------------------------------
// Template repo path (for the parity test)
// ---------------------------------------------------------------------------

const SKILL_EVALUATOR_DIR = path.join(TEMPLATE_REPO, 'plugins', 'skill-evaluator');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-vercel-validate-test-'));
}

/** Write a file, creating parent directories as needed. */
function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

/** Copy a directory tree recursively. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Build a minimal valid SKILL.md string for a skill with the given name.
 * The `name` in frontmatter must match the parent directory for the file to be valid.
 */
function minimalSkillMd(name: string, description = 'A useful skill.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody text here.\n`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('validateVercelPlugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Positive: no findings when everything is well-formed
  // -------------------------------------------------------------------------

  describe('positive cases', () => {
    it('returns zero findings when skills/ directory does not exist', () => {
      // No skills/ dir at all — no findings expected.
      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings for a single valid SKILL.md whose name matches its parent directory', () => {
      writeFile(tmpDir, 'skills/my-skill/SKILL.md', minimalSkillMd('my-skill'));

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('returns zero findings when body is exactly 500 lines (boundary at soft limit)', () => {
      // Body = 500 lines: "line N\n" × 500, so after trimStart there are exactly 500 lines.
      const bodyLines = Array.from({ length: 500 }, (_, i) => `line ${(i + 1).toString()}`).join(
        '\n',
      );
      const content = `---\nname: my-skill\ndescription: Valid.\n---\n\n${bodyLines}`;
      writeFile(tmpDir, 'skills/my-skill/SKILL.md', content);

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });

    it('validates multiple SKILL.md files independently and returns zero findings when all are valid', () => {
      writeFile(tmpDir, 'skills/skill-one/SKILL.md', minimalSkillMd('skill-one'));
      writeFile(tmpDir, 'skills/skill-two/SKILL.md', minimalSkillMd('skill-two'));

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: frontmatter shape failures
  // -------------------------------------------------------------------------

  describe('frontmatter shape failures', () => {
    it('emits a hard schema-invalid finding when SKILL.md has no frontmatter block', () => {
      writeFile(tmpDir, 'skills/my-skill/SKILL.md', '# No Frontmatter\n\nJust a body.\n');

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.code).toBe('schema-invalid');
      expect(findings[0]?.plugin).toBe(path.basename(tmpDir));
      expect(findings[0]?.message).toContain('SKILL.md');
      expect(findings[0]?.message).toContain('no frontmatter');
    });

    it('emits a hard schema-invalid finding when frontmatter is missing description', () => {
      writeFile(tmpDir, 'skills/my-skill/SKILL.md', '---\nname: my-skill\n---\n\n# Body\n');

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.code).toBe('schema-invalid');
      expect(findings[0]?.message).toContain('my-skill');
    });

    it('emits a hard schema-invalid finding when frontmatter name exceeds 64 characters', () => {
      // 65-char name: 'a' + 64 × 'b'
      const longName = 'a' + 'b'.repeat(64);
      // Write into a directory whose name matches the long name so the only error
      // is the length violation, not the name-consistency check. The directory
      // name itself can exceed 64 chars — the SKILL.md schema is what rejects it.
      writeFile(tmpDir, `skills/${longName}/SKILL.md`, minimalSkillMd(longName));

      const findings = validateVercelPlugin(tmpDir);

      expect(findings.length).toBeGreaterThanOrEqual(1);
      const schemaFindings = findings.filter((f) => f.code === 'schema-invalid');
      expect(schemaFindings.length).toBeGreaterThanOrEqual(1);
      expect(schemaFindings[0]?.severity).toBe('hard');
    });

    it('emits a hard schema-invalid finding when frontmatter name contains uppercase letters', () => {
      // Parent dir is "my-skill" to isolate the name constraint violation.
      writeFile(
        tmpDir,
        'skills/my-skill/SKILL.md',
        '---\nname: MySkill\ndescription: Valid.\n---\n\n# Body\n',
      );

      const findings = validateVercelPlugin(tmpDir);

      // At minimum one hard schema-invalid finding for uppercase in name.
      const schemaFindings = findings.filter(
        (f) => f.code === 'schema-invalid' && f.severity === 'hard',
      );
      expect(schemaFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('emits a hard schema-invalid finding when frontmatter name contains consecutive hyphens (--)', () => {
      // Parent dir is "foo" to isolate the name constraint.
      writeFile(
        tmpDir,
        'skills/foo/SKILL.md',
        '---\nname: foo--bar\ndescription: Valid.\n---\n\n# Body\n',
      );

      const findings = validateVercelPlugin(tmpDir);

      const schemaFindings = findings.filter(
        (f) => f.code === 'schema-invalid' && f.severity === 'hard',
      );
      expect(schemaFindings.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: name-consistency failure
  // -------------------------------------------------------------------------

  describe('name-consistency failures', () => {
    it('emits a hard name-consistency finding when frontmatter name does not match parent directory', () => {
      // frontmatter name: "foo", parent dir: "bar" → name-consistency violation
      writeFile(
        tmpDir,
        'skills/bar/SKILL.md',
        '---\nname: foo\ndescription: Valid.\n---\n\n# Body\n',
      );

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('hard');
      expect(findings[0]?.code).toBe('name-consistency');
      expect(findings[0]?.plugin).toBe(path.basename(tmpDir));
      expect(findings[0]?.message).toContain('"foo"');
      expect(findings[0]?.message).toContain('"bar"');
    });
  });

  // -------------------------------------------------------------------------
  // Negative (soft): body line-count recommendation
  // -------------------------------------------------------------------------

  describe('body line-count recommendation', () => {
    it('emits a soft schema-invalid finding when body exceeds 500 lines', () => {
      // Body = 501 lines: exactly one over the soft limit.
      const bodyLines = Array.from({ length: 501 }, (_, i) => `line ${(i + 1).toString()}`).join(
        '\n',
      );
      const content = `---\nname: my-skill\ndescription: Valid.\n---\n\n${bodyLines}`;
      writeFile(tmpDir, 'skills/my-skill/SKILL.md', content);

      const findings = validateVercelPlugin(tmpDir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('soft');
      expect(findings[0]?.code).toBe('schema-invalid');
      expect(findings[0]?.plugin).toBe(path.basename(tmpDir));
      // Message must mention the file and the line count.
      expect(findings[0]?.message).toContain('SKILL.md');
      expect(findings[0]?.message).toContain('501');
    });
  });

  // -------------------------------------------------------------------------
  // Finding structure invariants
  // -------------------------------------------------------------------------

  describe('finding structure', () => {
    it('plugin field equals path.basename(pluginDir)', () => {
      const namedDir = path.join(tmpDir, 'my-special-plugin');
      fs.mkdirSync(namedDir);
      writeFile(namedDir, 'skills/bad-skill/SKILL.md', '# No Frontmatter\n');

      const findings = validateVercelPlugin(namedDir);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.plugin).toBe('my-special-plugin');
      }
    });

    it('does not recurse deeper than one level under skills/', () => {
      // A SKILL.md nested two levels deep should not be discovered.
      writeFile(tmpDir, 'skills/outer/inner/SKILL.md', '# Deeply Nested\n');

      const findings = validateVercelPlugin(tmpDir);

      // The outer/ directory has no SKILL.md at depth 1, so nothing is found.
      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Parity: zero findings on the real skill-evaluator plugin
  // -------------------------------------------------------------------------

  describe('parity with skill-evaluator', () => {
    it('returns zero findings when run against a copy of the skill-evaluator plugin', () => {
      const pluginCopy = path.join(tmpDir, 'skill-evaluator');
      copyDirRecursive(SKILL_EVALUATOR_DIR, pluginCopy);

      const findings = validateVercelPlugin(pluginCopy);

      expect(findings).toHaveLength(0);
    });
  });
});
