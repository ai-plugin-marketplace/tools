/**
 * `correctness/plugin-self-containment` (§3.2, #118) — a file reference inside a plugin resolves
 * outside that plugin's directory.
 *
 * A plugin is installed on its own: the host copies (or mounts) the plugin directory and nothing
 * else from the repository it was authored in. A reference that climbs out of the plugin — to a
 * shared docs folder, a repo script, or a contributor-only skill in a host's project-local folder —
 * works while the author tests inside the repository and is broken for every user. This rule is
 * what keeps published content from depending on unpublished content, without the toolkit having
 * to model where unpublished content lives.
 *
 * Two kinds of reference are checked, in the same files `correctness/broken-file-ref` scans:
 *
 * - **Manifest/frontmatter path fields** (`hooks`/`commands`/`agents`/`skills`) whose value is a
 *   `./` or `../` relative path, resolved relative to the plugin directory — the convention every
 *   target schema uses.
 * - **Markdown links** in the body of a skill, agent, command or power file, resolved relative to
 *   the file that contains them. Code (fenced, indented or inline) and HTML comments are skipped:
 *   a link there is sample text, not a reference the host or the model will follow.
 *
 * Whether the target exists is not this rule's concern (that is `broken-file-ref`); only whether it
 * lies inside the plugin.
 *
 * @see docs/specs/lint-engine.md §3.2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { offsetToPosition, rangeForPath } from '../document.js';
import type { Diagnostic, Range, Rule, RuleContext } from '../types.js';
import { candidateRelPaths, collectTopLevelRefs, type FoundRef } from './broken-file-ref.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/plugin-self-containment';

/** A URI scheme prefix (`https:`, `mailto:`, …) — such a link target is not a file path. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Inline markdown link or image: `[text](target)` / `[text](<target> "title")`. Group 1 is the
 * target with any surrounding angle brackets removed by the caller.
 */
const INLINE_LINK_RE = /\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** Reference-style link definition: `[label]: target`, at the start of a line. */
const LINK_DEFINITION_RE = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;

/** An opening or closing code-fence line: up to three spaces, then three or more ` or ~. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** An HTML comment, possibly spanning lines. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** An inline code span: a run of backticks, content, then a run of the same length. */
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/** A line indented as a code block: four or more spaces, or a tab. */
const INDENTED_LINE_RE = /^(?: {4,}|\t)\S/;

/** Replace every character except line breaks with a space, preserving length and line structure. */
function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

/**
 * Blank out every region of a markdown text whose contents are literal text rather than markup a
 * reader or host would follow as a link: fenced code blocks, indented code blocks, HTML comments
 * and inline code spans. Every newline and the text's total length are preserved, so offsets into
 * the result still index the original text.
 *
 * A fence closes on a line that starts with the same character repeated at least as many times as
 * the opening fence; an unclosed fence runs to the end of the text (CommonMark behavior). An
 * indented code block is recognized conservatively — an indented line directly after a blank line
 * (or at the start of the text), and the indented lines that follow it — so an indented list
 * continuation, which follows a non-blank line, is still scanned.
 */
function blankLiteralRegions(text: string): string {
  const lines = text.split('\n');
  let fence: { char: string; length: number } | undefined;
  let inIndentedBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMarker = FENCE_LINE_RE.exec(line)?.[1];
    if (fence !== undefined) {
      lines[i] = blank(line);
      if (
        fenceMarker !== undefined &&
        fenceMarker.startsWith(fence.char) &&
        fenceMarker.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMarker !== undefined) {
      fence = { char: fenceMarker.charAt(0), length: fenceMarker.length };
      inIndentedBlock = false;
      continue;
    }
    const previousBlank = i === 0 || (lines[i - 1] ?? '').trim().length === 0;
    if (INDENTED_LINE_RE.test(line) && (inIndentedBlock || previousBlank)) {
      inIndentedBlock = true;
      lines[i] = blank(line);
      continue;
    }
    if (line.trim().length > 0) inIndentedBlock = false;
  }
  return lines.join('\n').replace(HTML_COMMENT_RE, blank).replace(INLINE_CODE_RE, blank);
}

/**
 * A relative-path-shaped manifest value: one that names a location by `./` or `../` (with either
 * separator, since a manifest authored on Windows may use `\\`). Absolute strings are deliberately
 * not treated as references: the path-bearing fields also hold inline hook definitions, whose
 * `command` values routinely start with an absolute interpreter path (`/usr/bin/env bash …`) and
 * are shell command lines, not files the plugin ships.
 */
function isPathShapedRef(value: string): boolean {
  return /^\.\.?[\\/]/.test(value);
}

/** Convert `\\` separators to `/` so a Windows-style relative path resolves the same everywhere. */
function toPosixSeparators(ref: string): string {
  return ref.replace(/\\/g, '/');
}

/** True iff `child` is `parent` itself or lies inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A markdown link target found in a file body, with the offset of the target in the file text. */
interface BodyLink {
  target: string;
  offset: number;
}

/**
 * Collect relative-file link targets from a markdown file's text. Targets that are URLs,
 * in-page anchors, or site-absolute (`/x`, which has no defined base inside a plugin) are not
 * file references and are skipped. Any `#fragment` or `?query` suffix is dropped.
 */
function collectBodyLinks(text: string): BodyLink[] {
  const scannable = blankLiteralRegions(text);
  const links: BodyLink[] = [];
  for (const re of [INLINE_LINK_RE, LINK_DEFINITION_RE]) {
    re.lastIndex = 0;
    for (const match of scannable.matchAll(re)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const bracketed = raw.startsWith('<') && raw.endsWith('>');
      const target = (bracketed ? raw.slice(1, -1) : raw).replace(/[#?].*$/, '');
      if (target.length === 0) continue;
      if (SCHEME_RE.test(target) || target.startsWith('/')) continue;
      const offset = match.index + match[0].indexOf(raw) + (bracketed ? 1 : 0);
      links.push({ target, offset });
    }
  }
  return links;
}

function diagnosticFor(
  rel: string,
  ref: string,
  where: string,
  range: Range | undefined,
): Diagnostic {
  return {
    ruleId: RULE_ID,
    category: 'correctness',
    severity: 'error',
    message: `${rel}: reference '${ref}' ${where} resolves outside the plugin directory, so it will not exist once the plugin is installed.`,
    file: rel,
    docsUrl: docsUrlFor(RULE_ID),
    hint: `Move the referenced file into the plugin and reference it from there. A plugin must not depend on files elsewhere in the repository, including contributor-only skills.`,
    ...(range !== undefined ? { range } : {}),
  };
}

export const pluginSelfContainmentRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'File references inside a plugin resolve within that plugin, so it works once installed on its own.',
    // Needs a plugin directory to be "inside of" — every mode whose unit is a plugin.
    appliesTo: ['aipm-repo', 'claude-plugin', 'open-plugins'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const rel of candidateRelPaths(ctx.pluginDir)) {
      const absPath = path.join(ctx.pluginDir, rel);
      if (!fs.existsSync(absPath)) continue;
      const doc = ctx.getDocument(absPath);

      if (doc?.value !== undefined) {
        const refs: FoundRef[] = [];
        collectTopLevelRefs(doc.value, refs, isPathShapedRef);
        for (const { path: refPath, ref } of refs) {
          if (isWithin(ctx.pluginDir, path.resolve(ctx.pluginDir, toPosixSeparators(ref))))
            continue;
          diagnostics.push(
            diagnosticFor(rel, ref, `at '${refPath.join('.')}'`, rangeForPath(doc, refPath)),
          );
        }
      }

      if (rel.endsWith('.md')) {
        // Read through the document layer when it parsed (so the file counts toward scan scope);
        // a markdown file without frontmatter has no document, so fall back to the raw text.
        const text = doc?.text ?? fs.readFileSync(absPath, 'utf-8');
        for (const { target, offset } of collectBodyLinks(text)) {
          const resolved = path.resolve(path.dirname(absPath), toPosixSeparators(target));
          if (isWithin(ctx.pluginDir, resolved)) continue;
          diagnostics.push(
            diagnosticFor(rel, target, 'in a markdown link', {
              start: offsetToPosition(text, offset),
              end: offsetToPosition(text, offset + target.length),
            }),
          );
        }
      }
    }

    return diagnostics;
  },
};
