/**
 * Position-aware document layer (L-D3).
 *
 * All content parsing that a rule needs positions for flows through here: JSON via
 * `jsonc-parser` (offset→line/col), YAML via the `yaml` package's CST, markdown frontmatter via
 * offset-tracked extraction. Zod validation runs against the plain `value`; a Zod issue's `path`
 * is resolved back to a document node's {@link Range} via {@link rangeForPath}. No rule re-parses
 * files ad hoc.
 *
 * `jsonc-parser` is used **only for position tracking** — the `value` for a JSON document is
 * produced by strict `JSON.parse`, so comments or trailing commas fail parsing exactly as a
 * host-conformant JSON manifest reader would (L-D3).
 *
 * @see docs/specs/lint-engine.md L-D3
 */

import * as jsonc from 'jsonc-parser';
import { parseDocument as parseYamlDocument, type Document as YamlCstDocument } from 'yaml';
import type { Position, Range } from './types.js';

/**
 * Matches a YAML frontmatter block, anchored to the **start of the file** (after an optional
 * UTF-8 BOM). No `m` flag — a `---` thematic break in the markdown body is never mistaken for
 * frontmatter — and `\r?\n` so CRLF checkouts are detected too. Group 1 is the YAML between the
 * fences. Mirrors `pipeline/validate.ts`'s `FRONTMATTER_RE`. The `d` (`hasIndices`) flag gives
 * `exec()` a `.indices` array carrying each group's own `[start, end]` offsets, computed by the
 * regex engine itself — this is what lets {@link parseFrontmatterDocument} locate group 1
 * structurally rather than via a fragile `indexOf(matchedText)` (which breaks when the group is
 * empty, since `''.indexOf('')` is always `0` regardless of true position).
 */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/d;

/**
 * Parser-internal position-lookup structures, kept out of the public {@link Document} types so
 * the public API surface never references `jsonc-parser` or `yaml` types. Internal-only,
 * non-exported side channel — {@link rangeForPath} is the sole reader. Keyed by object identity
 * on the `Document` it was parsed for.
 */
const internalTrees = new WeakMap<object, jsonc.Node | YamlCstDocument>();

/**
 * A JSON document, position-tracked via a `jsonc-parser` parse tree (kept internal — see
 * {@link internalTrees}).
 *
 * @public
 */
export interface JsonDocument {
  format: 'json';
  /** Absolute path to the source file. */
  path: string;
  /** Full file text. */
  text: string;
  /** Strict-parsed value (undefined when the text is not valid JSON). */
  value: unknown;
  /** Parse error, when `value` is undefined. */
  parseError?: string;
}

/**
 * A standalone YAML document (e.g. `hooks/claude.yaml`), position-tracked via the YAML CST (kept
 * internal — see {@link internalTrees}).
 *
 * @public
 */
export interface YamlDocument {
  format: 'yaml';
  path: string;
  text: string;
  value: unknown;
  parseError?: string;
}

/**
 * A markdown file's YAML frontmatter block, offset-tracked against the full file text.
 *
 * @public
 */
export interface FrontmatterDocument {
  format: 'frontmatter';
  path: string;
  /** Full markdown file text (not just the frontmatter block). */
  text: string;
  /** The extracted frontmatter YAML text (between the `---` fences). */
  yamlText: string;
  /** Offset of `yamlText[0]` within `text`. */
  yamlOffset: number;
  value: unknown;
  parseError?: string;
}

/**
 * A position-aware parsed document.
 *
 * @public
 */
export type Document = JsonDocument | YamlDocument | FrontmatterDocument;

/**
 * Convert a 0-indexed character offset into a 1-indexed {@link Position} within `text`.
 * Counts UTF-16 code units (matching how JS string indices and `jsonc-parser`/`yaml` offsets
 * are defined) — not a substitute for byte or codepoint counting.
 */
export function offsetToPosition(text: string, offset: number): Position {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/** Parse a JSON file into a position-tracked {@link JsonDocument}. */
export function parseJsonDocument(path: string, text: string): JsonDocument {
  const errors: jsonc.ParseError[] = [];
  const tree = jsonc.parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  let doc: JsonDocument;
  try {
    doc = { format: 'json', path, text, value: JSON.parse(text) as unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    doc = { format: 'json', path, text, value: undefined, parseError: message };
  }
  if (tree !== undefined) internalTrees.set(doc, tree);
  return doc;
}

/** Parse a standalone YAML file into a position-tracked {@link YamlDocument}. */
export function parseYamlDocumentFile(path: string, text: string): YamlDocument {
  const cstDoc = parseYamlDocument(text);
  let doc: YamlDocument;
  if (cstDoc.errors.length > 0) {
    doc = {
      format: 'yaml',
      path,
      text,
      value: undefined,
      parseError: cstDoc.errors[0]?.message ?? 'YAML parse error',
    };
  } else {
    doc = { format: 'yaml', path, text, value: cstDoc.toJS() as unknown };
  }
  internalTrees.set(doc, cstDoc);
  return doc;
}

/**
 * Extract and parse a markdown file's YAML frontmatter block into a position-tracked
 * {@link FrontmatterDocument}. Returns `undefined` when the file has no leading `---` frontmatter
 * block (mirrors `pipeline/validate.ts`'s `frontmatterParseError` "nothing to validate" case).
 */
export function parseFrontmatterDocument(
  path: string,
  text: string,
): FrontmatterDocument | undefined {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return undefined;
  const yamlText = match[1] ?? '';
  // Group 1's absolute start offset, read directly from the `d`-flag `.indices` array (computed
  // by the regex engine, not derived via `indexOf`) — correct even when `yamlText` is empty
  // (e.g. `---\n---\n`), which an `indexOf('')`-based computation would silently mispoint to 0.
  const group1Indices = match.indices?.[1];
  const yamlOffset = group1Indices?.[0] ?? match.index;
  const cstDoc = parseYamlDocument(yamlText);
  let doc: FrontmatterDocument;
  if (cstDoc.errors.length > 0) {
    doc = {
      format: 'frontmatter',
      path,
      text,
      yamlText,
      yamlOffset,
      value: undefined,
      parseError: cstDoc.errors[0]?.message ?? 'YAML parse error',
    };
  } else {
    doc = {
      format: 'frontmatter',
      path,
      text,
      yamlText,
      yamlOffset,
      value: cstDoc.toJS() as unknown,
    };
  }
  internalTrees.set(doc, cstDoc);
  return doc;
}

/** Load the appropriate document parser based on file extension. */
export function parseDocument(path: string, text: string): Document | undefined {
  if (path.endsWith('.json')) return parseJsonDocument(path, text);
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return parseYamlDocumentFile(path, text);
  if (path.endsWith('.md')) return parseFrontmatterDocument(path, text);
  return undefined;
}

/**
 * Resolve a Zod-style issue path (string/number segments) to a {@link Range} within `doc`.
 * Returns `undefined` when the path cannot be located (e.g. the path targets a key that doesn't
 * exist in a document that otherwise parsed, or the document failed to parse at all).
 */
export function rangeForPath(
  doc: Document,
  issuePath: readonly (string | number)[],
): Range | undefined {
  const internal = internalTrees.get(doc);

  if (doc.format === 'json') {
    if (internal === undefined) return undefined;
    const tree = internal as jsonc.Node;
    const node = jsonc.findNodeAtLocation(tree, [...issuePath]);
    if (node === undefined) return undefined;
    return {
      start: offsetToPosition(doc.text, node.offset),
      end: offsetToPosition(doc.text, node.offset + node.length),
    };
  }

  // yaml / frontmatter: resolve against the CST document, then map the (yaml-text-relative)
  // offsets back onto the full file text.
  if (internal === undefined) return undefined;
  const cstDoc = internal as YamlCstDocument;
  let node: unknown;
  try {
    node = cstDoc.getIn([...issuePath], true);
  } catch {
    return undefined;
  }
  const range = (node as { range?: readonly number[] } | null)?.range;
  if (range === undefined) return undefined;
  const baseOffset = doc.format === 'frontmatter' ? doc.yamlOffset : 0;
  // yaml's Node#range is [start, valueEnd, end] — `end` (index 2) extends past the value to
  // include trailing whitespace/comments consumed while scanning; `valueEnd` (index 1) is the
  // exact end of the value itself, which is what callers expect a "tight" Range to mean here.
  const [startOffset, valueEndOffset] = range;
  if (startOffset === undefined || valueEndOffset === undefined) return undefined;
  return {
    start: offsetToPosition(doc.text, baseOffset + startOffset),
    end: offsetToPosition(doc.text, baseOffset + valueEndOffset),
  };
}
