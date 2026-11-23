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
 * the projection reports. The rule computes the same host forms the build writes from
 * (`computePluginHostForms`), so what it reports is exactly what decided the build's output.
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import { computePluginHostForms } from '../../pipeline/host-forms.js';
import type { Finding } from '../../pipeline/types.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'portability/host-projection';

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
    const forms = computePluginHostForms(ctx.pluginDir, ctx.envelope);
    const findings: Finding[] = [
      ...forms.sourceFindings,
      ...forms.hosts.flatMap((host) => host.findings),
    ];
    return findings.map((f) => findingToDiagnostic(f, RULE_ID, 'portability', docsUrlFor(RULE_ID)));
  },
};
