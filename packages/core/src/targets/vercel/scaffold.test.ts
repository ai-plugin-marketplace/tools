/**
 * Tests for the Vercel Skills CLI scaffold templates.
 *
 * Asserts the produced `skills/<name>/SKILL.md` frontmatter parses against
 * `vercelSkillFrontmatterSchema`, carries `schemaVersion: "0.1.0"` (§12.2), and that the skill
 * directory name equals the frontmatter `name`. Negative: an invalid slug must fail the schema.
 *
 * @see https://agentskills.io
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { vercelSkillFrontmatterSchema } from './schemas.js';
import { scaffoldVercelFiles } from './scaffold.js';

function parseFrontmatter(content: string): unknown {
  const match = /^---\s*\n([\s\S]*?)\n---/m.exec(content);
  expect(match, 'expected SKILL.md to start with YAML frontmatter').not.toBeNull();
  return parseYaml(match?.[1] ?? '');
}

/** Return the content of the sole scaffolded SKILL.md file. */
function skillMdContent(name: string, description: string): string {
  const file = scaffoldVercelFiles(name, { description })[0];
  return file?.content ?? '';
}

describe('scaffoldVercelFiles', () => {
  it('produces a SKILL.md under skills/<name>/', () => {
    const files = scaffoldVercelFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['skills/my-plugin/SKILL.md']);
  });

  it('produces frontmatter that parses against the Vercel skill schema', () => {
    const fm = parseFrontmatter(skillMdContent('my-plugin', 'Does a thing'));
    expect(vercelSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, and description; dir name matches name', () => {
    const file = scaffoldVercelFiles('my-plugin', { description: 'Does a thing' })[0];
    const fm = parseFrontmatter(file?.content ?? '') as Record<string, unknown>;
    expect(fm.schemaVersion).toBe('0.1.0');
    expect(fm.name).toBe('my-plugin');
    expect(fm.description).toBe('Does a thing');
    // Cross-validator invariant: skills/<dir>/ must equal frontmatter name.
    expect(file?.path).toBe('skills/my-plugin/SKILL.md');
  });

  it('rejects an invalid slug name at the schema level (negative)', () => {
    // A name with a trailing hyphen violates the agentskills.io slug rules.
    const fm = parseFrontmatter(skillMdContent('bad-', 'Does a thing'));
    expect(vercelSkillFrontmatterSchema.safeParse(fm).success).toBe(false);
  });

  // Regression test for issue #90: `description` is REQUIRED and constrained to min length 1
  // (schemas.ts), unlike the optional-description targets (Claude/Codex/Cursor/Open Plugins),
  // which omit the key entirely in placeholder mode. Blanking it to `""` here would be
  // schema-invalid on write, not merely incomplete.
  it('emits non-empty placeholder description in placeholder mode and stays schema-valid (issue #90)', () => {
    const file = scaffoldVercelFiles('my-plugin', { placeholder: true })[0];
    expect(file?.content).not.toContain('description: ""');

    const fm = parseFrontmatter(file?.content ?? '') as Record<string, unknown>;
    expect(fm.description).toBeTypeOf('string');
    expect((fm.description as string).length).toBeGreaterThan(0);
    expect(vercelSkillFrontmatterSchema.safeParse(fm).success).toBe(true);
  });
});
