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

/** Recursively collect every `./`-prefixed string value in a parsed document value. */
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
  },
  check(ctx: RuleContext): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const rel of candidateRelPaths(ctx.pluginDir)) {
      const absPath = path.join(ctx.pluginDir, rel);
      if (!fs.existsSync(absPath)) continue;
      const doc = ctx.getDocument(absPath);
      if (doc?.value === undefined) continue;

      const refs: FoundRef[] = [];
      collectRefs(doc.value, [], refs);

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
