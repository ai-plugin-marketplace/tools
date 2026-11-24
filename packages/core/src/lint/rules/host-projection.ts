/**
 * `portability/host-projection` — how a plugin's authored features reach each target of its
 * support envelope.
 *
 * Some authored features are stated once in the source and delivered differently per target: a
 * skill's audience (`audience` / `audience-fallback` in `SKILL.md` frontmatter) is the first. The
 * build asks `@ai-plugin-marketplace/normalizer` what each target's form of the plugin is; this
 * rule reports the findings that come with that answer, so `validate`, `lint` and a build's own
 * validation all show them:
 *
 * - findings about the source itself (an unusable declaration, a skill that cannot be read
 *   safely). A `hard` one means the plugin cannot be built for any target;
 * - findings about one target (a skill left out where its audience cannot be enforced, a prefix
 *   fallback that cannot be built). A `hard` one fails that target only.
 *
 * Each finding's own `code` becomes the diagnostic's `legacyCode`, so one rule carries every code
 * the projection reports. The rule reads the same host forms the build writes from (the run's
 * `HostFormsRun`), so what it reports is exactly what decided the build's output. That includes
 * the two findings the pipeline adds to a target: changes that cannot be applied, and a tree path
 * occupied by a directory the toolkit did not write (`generated-tree-collision`).
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import * as path from 'node:path';

import type { Finding } from '../../pipeline/types.js';
import { validateFrontmatterParses } from '../../pipeline/validate.js';
import { hostFormsRunOf } from '../context.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'portability/host-projection';

/**
 * Drop the projection's report of a `SKILL.md` whose frontmatter is not valid YAML when
 * `correctness/frontmatter-invalid` reports that same file, so the author reads about it once.
 *
 * The projection names the file at the start of its message (`<path>: ...`) and the frontmatter
 * check quotes the same plugin-relative path. A finding is dropped only on that exact match;
 * anything else the projection reports as `schema-invalid` is kept. This affects reporting only:
 * whether the finding fails the plugin was decided from the full list.
 */
function withoutFrontmatterDuplicates(findings: readonly Finding[], pluginDir: string): Finding[] {
  const candidates = findings.filter((f) => f.code === 'schema-invalid');
  if (candidates.length === 0) return [...findings];
  const alreadyReported = validateFrontmatterParses(pluginDir, path.basename(pluginDir)).map(
    (f) => f.message,
  );
  return findings.filter((f) => {
    if (f.code !== 'schema-invalid') return true;
    const file = f.message.slice(0, Math.max(0, f.message.indexOf(': ')));
    return file === '' || !alreadyReported.some((message) => message.includes(`'${file}'`));
  });
}

export const hostProjectionRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'portability',
    defaultSeverity: 'error',
    description:
      "Every authored feature of a plugin can be carried to each target in the plugin's support envelope.",
    // Projects onto the resolved aipm.config.ts envelope — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    const forms = hostFormsRunOf(ctx).forms(ctx.pluginDir, ctx.envelope);
    const findings: Finding[] = [
      ...withoutFrontmatterDuplicates(forms.sourceFindings, ctx.pluginDir),
      ...forms.hosts.flatMap((host) => host.findings),
    ];
    return findings.map((f) => findingToDiagnostic(f, RULE_ID, 'portability', docsUrlFor(RULE_ID)));
  },
};
