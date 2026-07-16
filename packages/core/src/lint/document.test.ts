/**
 * Position-fidelity tests for the document layer (L-D3).
 *
 * Every expected `{line, col}` below is hand-derived by counting characters in the fixture text
 * (both 1-indexed, per `offsetToPosition`'s documented contract) — never captured by running the
 * parser and copying its output. See the inline derivation comment on each test.
 *
 * @see docs/specs/lint-engine.md L-D3
 */

import { describe, expect, it } from 'vitest';
import {
  offsetToPosition,
  parseFrontmatterDocument,
  parseJsonDocument,
  parseYamlDocumentFile,
  rangeForPath,
} from './document.js';

describe('offsetToPosition()', () => {
  it('returns {line: 1, col: 1} for offset 0', () => {
    expect(offsetToPosition('abc', 0)).toEqual({ line: 1, col: 1 });
  });

  it('advances col within the first line', () => {
    // "abc" — offset 2 is the 3rd character ('c'), so col 3, still line 1 (no newline yet).
    expect(offsetToPosition('abc', 2)).toEqual({ line: 1, col: 3 });
  });

  it('resets col to 1 and increments line after a newline', () => {
    // "ab\ncd" — offset 3 is 'c', the first character of line 2.
    expect(offsetToPosition('ab\ncd', 3)).toEqual({ line: 2, col: 1 });
  });

  it('counts multiple newlines', () => {
    // "a\nb\nc" — offset 4 is 'c', the first character of line 3.
    expect(offsetToPosition('a\nb\nc', 4)).toEqual({ line: 3, col: 1 });
  });
});

describe('JSON document — position fidelity', () => {
  // Fixture, with explicit \n so every offset is unambiguous:
  //   line 1: {
  //   line 2:   "name": "foo",
  //   line 3:   "version": 1
  //   line 4: }
  //
  // Derivation of the range for path ['version']:
  //   line 1 "{" is 1 char (offset 0), then '\n' at offset 1.
  //   line 2 '  "name": "foo",' is 16 chars (offsets 2-17), then '\n' at offset 18.
  //   line 3 '  "version": 1' is 14 chars (offsets 19-32): indices within the line are
  //     ' '(0) ' '(1) '"'(2) v(3) e(4) r(5) s(6) i(7) o(8) n(9) '"'(10) ':'(11) ' '(12) '1'(13)
  //     — so the value '1' sits at line-local index 13, i.e. absolute offset 19+13 = 32.
  //   offsetToPosition(text, 32): newlines strictly before offset 32 are at offsets 1 and 18
  //     (2 newlines) → line = 3; chars since the offset-18 newline up to (not including) 32 are
  //     offsets 19..31 (13 chars) → col = 1 + 13 = 14.
  //   The value is 1 character long, so the end offset is 33 → line 3, col 15.
  const text = '{\n  "name": "foo",\n  "version": 1\n}\n';

  it('resolves the range of a top-level property to its exact line/col', () => {
    const doc = parseJsonDocument('manifest.json', text);
    expect(doc.value).toEqual({ name: 'foo', version: 1 });
    const range = rangeForPath(doc, ['version']);
    expect(range).toEqual({ start: { line: 3, col: 14 }, end: { line: 3, col: 15 } });
  });

  it('returns undefined for a path that does not exist in the document', () => {
    const doc = parseJsonDocument('manifest.json', text);
    expect(rangeForPath(doc, ['nonexistent'])).toBeUndefined();
  });

  it('reports a parse error (and no value) for malformed JSON, without throwing', () => {
    const doc = parseJsonDocument('manifest.json', '{ "name": "foo", }');
    expect(doc.value).toBeUndefined();
    expect(doc.parseError).toBeDefined();
  });
});

describe('YAML document — position fidelity', () => {
  // Fixture:
  //   line 1: name: foo
  //   line 2: version: 1
  //
  // Derivation of the range for path ['version']:
  //   line 1 'name: foo' is 9 chars (offsets 0-8), then '\n' at offset 9.
  //   line 2 'version: 1' is 10 chars (offsets 10-19): v(0)e(1)r(2)s(3)i(4)o(5)n(6):(7) (8)1(9)
  //     — so '1' sits at line-local index 9, absolute offset 10+9 = 19.
  //   offsetToPosition(text, 19): 1 newline before offset 19 (at offset 9) → line = 2;
  //     chars since that newline up to (not including) 19 are offsets 10..18 (9 chars) →
  //     col = 1 + 9 = 10.
  //   The value is 1 character long, so the end offset is 20 → line 2, col 11.
  const text = 'name: foo\nversion: 1\n';

  it('resolves the range of a top-level property to its exact line/col', () => {
    const doc = parseYamlDocumentFile('hooks/claude.yaml', text);
    expect(doc.value).toEqual({ name: 'foo', version: 1 });
    const range = rangeForPath(doc, ['version']);
    expect(range).toEqual({ start: { line: 2, col: 10 }, end: { line: 2, col: 11 } });
  });

  it('reports a parse error (and no value) for malformed YAML, without throwing', () => {
    // A tab character is illegal as YAML indentation.
    const doc = parseYamlDocumentFile('hooks/claude.yaml', 'a:\n\tb: 1\n');
    expect(doc.value).toBeUndefined();
    expect(doc.parseError).toBeDefined();
  });
});

describe('Frontmatter document — position fidelity', () => {
  // Fixture (markdown file with a YAML frontmatter block):
  //   line 1: ---
  //   line 2: name: skill-foo
  //   line 3: version: 1
  //   line 4: ---
  //   line 5: (blank)
  //   line 6: # Title
  //
  // Derivation of the range for path ['version']:
  //   The opening fence '---\n' is 4 chars (offsets 0-3), so the extracted yamlText starts at
  //   yamlOffset = 4.
  //   Within yamlText ('name: skill-foo\nversion: 1'): line 'name: skill-foo' is 15 chars
  //   (local offsets 0-14), then '\n' at local offset 15; line 'version: 1' is 10 chars (local
  //   offsets 16-25): v(0)...n(6):(7) (8)1(9) — '1' at local index 9, i.e. local offset 16+9=25.
  //   Absolute offset in the full file = yamlOffset(4) + 25 = 29.
  //   offsetToPosition(text, 29): newlines strictly before offset 29 are the fence's own (offset
  //   3) and the one between the two yaml lines (offset 3 + 1 + 15 = 19) — 2 newlines → line = 3
  //   (physical line 3 of the file is 'version: 1', matching the fixture above); chars since the
  //   offset-19 newline up to (not including) 29 are offsets 20..28 (9 chars) → col = 1 + 9 = 10.
  //   The value is 1 character long, so the end offset is 30 → line 3, col 11.
  const text = '---\nname: skill-foo\nversion: 1\n---\n\n# Title\n';

  it('extracts the frontmatter block and resolves a field to its exact line/col', () => {
    const doc = parseFrontmatterDocument('SKILL.md', text);
    expect(doc).toBeDefined();
    expect(doc?.value).toEqual({ name: 'skill-foo', version: 1 });
    const range = doc !== undefined ? rangeForPath(doc, ['version']) : undefined;
    expect(range).toEqual({ start: { line: 3, col: 10 }, end: { line: 3, col: 11 } });
  });

  it('returns undefined when the file has no leading frontmatter block', () => {
    expect(parseFrontmatterDocument('SKILL.md', '# No frontmatter here\n')).toBeUndefined();
  });

  it('does not mistake a "---" thematic break in the body for frontmatter', () => {
    // No leading "---" at the very start of the file — FRONTMATTER_RE has no `m` flag, so a
    // mid-document "---" is never treated as a frontmatter fence.
    const body = '# Title\n\n---\n\nSome content.\n';
    expect(parseFrontmatterDocument('SKILL.md', body)).toBeUndefined();
  });
});
