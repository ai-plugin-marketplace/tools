/**
 * The two rules that tie a skill's `metadata.internal` frontmatter marker to which side of the
 * published-surface boundary the skill sits on (L-D13, #118):
 *
 * - `correctness/unpublished-skill-installable` — a skill that is neither published nor generated
 *   lacks the marker, so install channels that walk the repository (the `skills` CLI) list and
 *   install it alongside the published ones.
 * - `correctness/published-skill-internal` — a published skill carries the marker, so those same
 *   channels hide it from the users it was published for.
 *
 * The marker is a discoverability control, not access control: it hides a skill from listing and
 * default install, and a user who names the skill explicitly can still install it. These rules
 * make the author's internal/external choice explicit and consistent; they do not make an
 * unpublished skill secret.
 *
 * Neither rule ever writes to an authored file — the diagnostic states the fix.
 *
 * @see docs/specs/lint-engine.md §3.2, L-D13
 */

import { rangeForPath } from '../document.js';
import { classifyRepoSkills } from '../skill-classification.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const UNPUBLISHED_INSTALLABLE_ID = 'correctness/unpublished-skill-installable';
const PUBLISHED_INTERNAL_ID = 'correctness/published-skill-internal';

export const unpublishedSkillInstallableRule: Rule = {
  meta: {
    id: UNPUBLISHED_INSTALLABLE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'Every skill outside a published plugin is marked `metadata.internal: true`, so repository-walking install channels do not offer it to users.',
    // "Published" is defined by the aipm plugins root — meaningless without an aipm repo layout.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: RuleContext): Promise<Diagnostic[]> {
    const skills = await classifyRepoSkills(ctx);
    if (skills === undefined) return [];

    const diagnostics: Diagnostic[] = [];
    for (const skill of skills) {
      if (skill.skillClass !== 'unpublished' || skill.markedInternal) continue;
      diagnostics.push({
        ruleId: UNPUBLISHED_INSTALLABLE_ID,
        category: 'correctness',
        severity: 'error',
        message: `${skill.relPath}: skill '${skill.name}' is not part of any published plugin, but is installable by anyone through channels that scan the repository for SKILL.md files (e.g. \`npx skills add\`).`,
        file: skill.relPath,
        docsUrl: docsUrlFor(UNPUBLISHED_INSTALLABLE_ID),
        hint: `Decide who this skill is for. If it is for contributors to this repository, add a \`metadata:\` block containing \`internal: true\` to the frontmatter of ${skill.relPath}. If it is for users of the published plugin, move it into that plugin's \`skills/\` directory instead.`,
        legacyCode: 'unpublished-skill-installable',
      });
    }
    return diagnostics;
  },
};

export const publishedSkillInternalRule: Rule = {
  meta: {
    id: PUBLISHED_INTERNAL_ID,
    category: 'correctness',
    defaultSeverity: 'warn',
    description:
      'No published skill is marked `metadata.internal: true`, which would hide it from the users it is published for.',
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: RuleContext): Promise<Diagnostic[]> {
    const skills = await classifyRepoSkills(ctx);
    if (skills === undefined) return [];

    const diagnostics: Diagnostic[] = [];
    for (const skill of skills) {
      if (skill.skillClass !== 'published' || !skill.markedInternal) continue;
      const doc = ctx.getDocument(skill.absPath);
      const range = doc !== undefined ? rangeForPath(doc, ['metadata', 'internal']) : undefined;
      diagnostics.push({
        ruleId: PUBLISHED_INTERNAL_ID,
        category: 'correctness',
        severity: 'warn',
        message: `${skill.relPath}: published skill '${skill.name}' is marked \`metadata.internal: true\`, so the \`skills\` CLI hides it from users.`,
        file: skill.relPath,
        docsUrl: docsUrlFor(PUBLISHED_INTERNAL_ID),
        hint: `Remove \`metadata.internal\` if this skill is for users. If it is for contributors only, move it out of the published plugin.`,
        ...(range !== undefined ? { range } : {}),
      });
    }
    return diagnostics;
  },
};
