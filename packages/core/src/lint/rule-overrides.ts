/**
 * Rule-severity overrides for `aipm lint --rule <id>=<severity>` (spec §4.1). The engine's
 * `lint()` deliberately returns unfiltered diagnostics (see `engine.ts`'s doc comment) — L-D6
 * per-rule severity configuration is this CLI issue's scope, applied here as a pure post-filter
 * over an already-computed `Diagnostic[]` rather than threaded through rule discovery.
 *
 * @see docs/specs/lint-engine.md L-D6, §4.1
 */

import type { Diagnostic } from './types.js';

/**
 * A `--rule <id>=<severity>` override value. `'off'` drops matching diagnostics entirely.
 *
 * @public
 */
export type RuleSeverityOverride = 'error' | 'warn' | 'info' | 'off';

/**
 * Apply `--rule` overrides to a diagnostic list: a diagnostic whose `ruleId` has an `'off'`
 * override is dropped; one with any other override has its `severity` replaced; diagnostics for
 * rule ids with no entry in `overrides` pass through unchanged. Order is preserved.
 *
 * @public
 */
export function applyRuleSeverityOverrides(
  diagnostics: readonly Diagnostic[],
  overrides: ReadonlyMap<string, RuleSeverityOverride>,
): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const override = overrides.get(diagnostic.ruleId);
    if (override === undefined) {
      result.push(diagnostic);
      continue;
    }
    if (override === 'off') continue;
    result.push({ ...diagnostic, severity: override });
  }
  return result;
}
