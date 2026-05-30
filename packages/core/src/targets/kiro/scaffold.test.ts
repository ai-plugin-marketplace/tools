/**
 * Tests for the Kiro scaffold templates.
 *
 * Asserts the produced `POWER.md` frontmatter parses against `kiroPowerMdFrontmatterSchema`,
 * carries `schemaVersion: "0.1.0"` (§12.2), and reflects the given name/description.
 *
 * @see docs/specs/architecture.md §6.4, §12.2, §12.5
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { kiroPowerMdFrontmatterSchema } from './schemas.js';
import { scaffoldKiroFiles } from './scaffold.js';

/** Return the content of the sole scaffolded POWER.md file. */
function powerMdContent(description: string): string {
  const files = scaffoldKiroFiles('my-plugin', { description });
  const file = files[0];
  expect(file?.path).toBe('POWER.md');
  return file?.content ?? '';
}

/** Extract and YAML-parse the leading `---`-delimited frontmatter block. */
function parseFrontmatter(content: string): unknown {
  const match = /^---\s*\n([\s\S]*?)\n---/m.exec(content);
  expect(match, 'expected POWER.md to start with YAML frontmatter').not.toBeNull();
  return parseYaml(match?.[1] ?? '');
}

describe('scaffoldKiroFiles', () => {
  it('produces the minimum-required POWER.md manifest', () => {
    const files = scaffoldKiroFiles('my-plugin', { description: 'Does a thing' });
    expect(files.map((f) => f.path)).toStrictEqual(['POWER.md']);
  });

  it('produces frontmatter that parses against the Kiro schema', () => {
    const fm = parseFrontmatter(powerMdContent('Does a thing'));
    expect(kiroPowerMdFrontmatterSchema.safeParse(fm).success).toBe(true);
  });

  it('sets schemaVersion to 0.1.0, name, description, and version', () => {
    const fm = parseFrontmatter(powerMdContent('Does a thing')) as Record<string, unknown>;
    expect(fm.schemaVersion).toBe('0.1.0');
    expect(fm.name).toBe('my-plugin');
    expect(fm.description).toBe('Does a thing');
    expect(fm.version).toBe('0.0.1');
  });

  it('quotes descriptions containing YAML-significant characters safely', () => {
    // A colon-bearing description would corrupt naive YAML; JSON.stringify keeps it a quoted scalar.
    const fm = parseFrontmatter(powerMdContent('does: things, and more')) as Record<
      string,
      unknown
    >;
    expect(fm.description).toBe('does: things, and more');
  });
});
