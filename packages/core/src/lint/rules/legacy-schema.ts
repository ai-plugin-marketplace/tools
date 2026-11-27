/**
 * `schema/target-conformance` — per-target manifest/filesystem conformance (§3.1). Wraps the
 * existing per-target `validate.ts` dispatch (`validatePerTargetSchemas`), which itself emits
 * `schema-invalid`, `metadata-dir-isolation`, and `open-plugins-conformance` findings depending
 * on the target and failure kind — each finding's own `code` becomes the diagnostic's
 * `legacyCode`, so one rule fairly represents several legacy codes (they are all "does this
 * target's manifest/filesystem conform" checks).
 *
 * @see docs/specs/lint-engine.md §3.1
 */

import { validatePerTargetSchemas } from '../../pipeline/validate.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'schema/target-conformance';

export const targetSchemaRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'schema',
    defaultSeverity: 'error',
    description:
      "Every target manifest in a plugin's support envelope parses against that target's current schema.",
    // Dispatches per the resolved aipm.config.ts envelope — aipm-repo only. (A foreign discovery
    // mode would instead validate a single known manifest shape directly, not via an envelope.)
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    const findings = validatePerTargetSchemas(ctx.pluginDir, ctx.envelope);
    return findings.map((f) => findingToDiagnostic(f, RULE_ID, 'schema', docsUrlFor(RULE_ID)));
  },
};
