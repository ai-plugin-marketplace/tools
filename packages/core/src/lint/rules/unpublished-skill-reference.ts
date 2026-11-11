/**
 * `correctness/unpublished-skill-reference` (§3.2, #118) — a published skill, agent or command
 * mentions the name of a skill that is not published.
 *
 * Published content that tells the model to "use the `release-checklist` skill" works for the
 * author, whose checkout has that contributor skill loaded, and fails for every user, who never
 * receives it. `correctness/plugin-self-containment` catches the file-path form of that
 * dependency; this rule catches the by-name form.
 *
 * **Heuristic (L-D7).** A name match in prose is not proof of a dependency: a contributor skill
 * named after an ordinary word (`release`, `review`) will match unrelated sentences. The rule
 * therefore defaults to `warn`, matches whole names only (never a substring of a longer
 * identifier), and ignores any unpublished name that a published skill also uses, since that
 * mention is satisfied by what the user does receive.
 *
 * @see docs/specs/lint-engine.md §3.2, L-D7, L-D13
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { offsetToPosition } from '../document.js';
import { classifyRepoSkills } from '../skill-classification.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { candidateRelPaths } from './broken-file-ref.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'correctness/unpublished-skill-reference';

/** Escape a literal string for use inside a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher for `name` as a whole identifier: not preceded or followed by a character that
 * could extend it (letters, digits, `_`, `-`), so `release` does not match inside `pre-release`
 * or `release-notes`.
 */
function wholeNameMatcher(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`);
}

export const unpublishedSkillReferenceRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'correctness',
    defaultSeverity: 'warn',
    description:
      'Published skills, agents and commands do not mention skills that users will not receive.',
    // "Unpublished" is defined against the aipm plugins root — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: RuleContext): Promise<Diagnostic[]> {
    const skills = await classifyRepoSkills(ctx);
    if (skills === undefined) return [];

    const publishedNames = new Set(
      skills.filter((s) => s.skillClass === 'published').map((s) => s.name),
    );
    const unpublishedNames = [
      ...new Set(
        skills
          .filter((s) => s.skillClass === 'unpublished' && !publishedNames.has(s.name))
          .map((s) => s.name),
      ),
    ].sort();
    if (unpublishedNames.length === 0) return [];
    const matchers = unpublishedNames.map((name) => ({ name, re: wholeNameMatcher(name) }));

    const diagnostics: Diagnostic[] = [];
    for (const pluginDir of ctx.allPluginDirs) {
      for (const rel of candidateRelPaths(pluginDir)) {
        if (!rel.endsWith('.md')) continue;
        const absPath = path.join(pluginDir, rel);
        if (!fs.existsSync(absPath)) continue;
        // Prefer the document layer (scan-scope accounting); a file without frontmatter has no
        // document, so read it directly.
        const text = ctx.getDocument(absPath)?.text ?? fs.readFileSync(absPath, 'utf-8');
        const file = path.relative(ctx.repoRoot, absPath).split(path.sep).join('/');

        for (const { name, re } of matchers) {
          const match = re.exec(text);
          if (match === null) continue;
          diagnostics.push({
            ruleId: RULE_ID,
            category: 'correctness',
            severity: 'warn',
            message: `${file}: mentions '${name}', the name of a skill that is not part of any published plugin. Users who install this plugin will not have it.`,
            file,
            docsUrl: docsUrlFor(RULE_ID),
            hint: `If this content relies on the '${name}' skill, move what it needs into the plugin. If the match is coincidental, lower or disable this rule for the repository.`,
            range: {
              start: offsetToPosition(text, match.index),
              end: offsetToPosition(text, match.index + name.length),
            },
          });
        }
      }
    }
    return diagnostics;
  },
};
