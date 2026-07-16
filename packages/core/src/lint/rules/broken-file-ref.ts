/**
 * `correctness/broken-file-ref` (§3.2, new rule) — manifest and frontmatter references to files
 * that don't exist.
 *
 * Scans every manifest/frontmatter document a plugin may author (per-target `plugin.json`s,
 * `gemini-extension.json`, `POWER.md`, and every `skills/<name>/SKILL.md`, `agents/*.md`,
 * `commands/*.md`) for string field values shaped like a relative reference (`./...`, the
 * convention every target schema already uses for `skills`/`agents`/`commands`/`hooks` fields —
 * see `targets/claude/schemas.ts`), and reports any that don't resolve to a real path relative to
 * the plugin directory. Diagnostics carry a range resolved from the source document via the
 * document layer (L-D3) whenever the owning field can be located.
 *
 * Collection is scoped to {@link PATH_BEARING_KEYS} — the specific top-level manifest fields that
 * the target schemas actually type as file/directory references — rather than walking the whole
 * parsed value. A prose field like `description` is never inspected, even when its value happens
 * to start with `./` (e.g. "./scripts contains helper code"); only `hooks`/`commands`/`agents`/
 * `skills` are.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { rangeForPath } from '../document.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/broken-file-ref';

/** A file-ref-shaped string value found while walking a parsed document, with its JSON/YAML path. */
interface FoundRef {
  path: (string | number)[];
  ref: string;
}

/**
 * Top-level manifest keys the target schemas type as genuine `./`-prefixed file/directory
 * references (see `hooks`/`commands`/`agents`/`skills` in `targets/claude/schemas.ts`, mirrored
 * across the other targets' schemas). Only these keys are walked for ref collection — a prose
 * field such as `description` or `argument-hint` is never inspected, regardless of its value.
 */
const PATH_BEARING_KEYS: ReadonlySet<string> = new Set(['hooks', 'commands', 'agents', 'skills']);

/** Recursively collect every `./`-prefixed string value within an already-scoped subtree. */
function collectRefs(value: unknown, pathSoFar: (string | number)[], out: FoundRef[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push({ path: pathSoFar, ref: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectRefs(v, [...pathSoFar, i], out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectRefs(v, [...pathSoFar, k], out);
  }
}

/**
 * Collect `./`-prefixed refs only from {@link PATH_BEARING_KEYS} top-level fields of a parsed
 * manifest/frontmatter value — never from prose fields like `description`.
 */
function collectTopLevelRefs(value: unknown, out: FoundRef[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, v] of Object.entries(value)) {
    if (!PATH_BEARING_KEYS.has(key)) continue;
    collectRefs(v, [key], out);
  }
}

/** Candidate manifest/frontmatter files this rule scans, relative to the plugin directory. */
function candidateRelPaths(pluginDir: string): string[] {
  const rel: string[] = [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.plugin/plugin.json',
    'gemini-extension.json',
    'POWER.md',
  ];

  const skillsDir = path.join(pluginDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) rel.push(`skills/${entry.name}/SKILL.md`);
    }
  }
  for (const sub of ['agents', 'commands'] as const) {
    const dir = path.join(pluginDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) rel.push(`${sub}/${entry.name}`);
    }
  }

  return rel;
}

export const brokenFileRefRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description: 'Manifest and frontmatter references to files that do not exist.',
    // Content-only (needs just the manifest/frontmatter file) — applies wherever one can appear.
    appliesTo: ['aipm-repo', 'claude-plugin', 'open-plugins', 'skills-dir', 'claude-user-config'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const rel of candidateRelPaths(ctx.pluginDir)) {
      const absPath = path.join(ctx.pluginDir, rel);
      if (!fs.existsSync(absPath)) continue;
      const doc = ctx.getDocument(absPath);
      if (doc?.value === undefined) continue;

      const refs: FoundRef[] = [];
      collectTopLevelRefs(doc.value, refs);

      for (const { path: refPath, ref } of refs) {
        const target = path.join(ctx.pluginDir, ref.slice(2));
        if (fs.existsSync(target)) continue;
        const range = rangeForPath(doc, refPath);
        const diagnostic: Diagnostic = {
          ruleId: RULE_ID,
          category: 'correctness',
          severity: 'error',
          message: `${rel}: reference '${ref}' at '${refPath.join('.')}' does not resolve to an existing file.`,
          file: rel,
          docsUrl: docsUrlFor(RULE_ID),
          hint: `Create '${ref}' relative to the plugin directory, or remove the reference from ${rel}.`,
        };
        if (range !== undefined) diagnostic.range = range;
        diagnostics.push(diagnostic);
      }
    }

    return diagnostics;
  },
};
