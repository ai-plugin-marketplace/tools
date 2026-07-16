/**
 * Rule-severity overrides for `aipm lint --rule <id>=<severity>` (spec §4.1). The engine's
 * `lint()` deliberately returns unfiltered diagnostics (see `engine.ts`'s doc comment) — L-D6
 * per-rule severity configuration is this CLI issue's scope, applied here as a pure post-filter
 * over an already-computed `Diagnostic[]` rather than threaded through rule discovery.
 *
 * @see docs/specs/lint-engine.md L-D6, §4.1
 */

import { docsUrlFor } from './rules/docs-url.js';
import type { Diagnostic } from './types.js';

/**
 * The synthetic diagnostic's `ruleId` for an unrecognized `--rule` override target (L-D6: "unknown
 * rule ids in config or suppressions are themselves a `warn` diagnostic" — typo protection). Its
 * `category` is `'schema'` even though the id reads `config/*`: `Diagnostic['category']` is a
 * closed union with no `'config'` member, and this is fundamentally a config-validity issue —
 * closest of the five to "malformed input", same as the legacy schema rules.
 */
const UNKNOWN_RULE_OVERRIDE_ID = 'config/unknown-rule';

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

/**
 * Flag `--rule <id>=<severity>` entries that don't match anything real: neither a diagnostic this
 * run actually produced nor any rule the engine has registered (L-D6 typo protection). Checking
 * both — not just `registeredRuleIds` — means an override is accepted whenever it evidently
 * corresponds to something real, even if the static registry were ever incomplete.
 *
 * Must be called with the diagnostics `lint()` produced BEFORE {@link applyRuleSeverityOverrides}
 * — an `=off` override legitimately removes its own rule's diagnostics from the post-filter list,
 * which would make a perfectly valid override look unmatched.
 *
 * @public
 */
export function unknownRuleOverrideDiagnostics(
  overrides: ReadonlyMap<string, RuleSeverityOverride>,
  diagnosticsBeforeOverrides: readonly Diagnostic[],
  registeredRuleIds: readonly string[],
): Diagnostic[] {
  const known = new Set(registeredRuleIds);
  const produced = new Set(diagnosticsBeforeOverrides.map((d) => d.ruleId));
  const result: Diagnostic[] = [];
  for (const ruleId of overrides.keys()) {
    if (known.has(ruleId) || produced.has(ruleId)) continue;
    result.push({
      ruleId: UNKNOWN_RULE_OVERRIDE_ID,
      category: 'schema',
      severity: 'warn',
      message: `--rule '${ruleId}' does not match any known rule id — check for a typo.`,
      file: '(cli)',
      docsUrl: docsUrlFor(UNKNOWN_RULE_OVERRIDE_ID),
    });
  }
  return result;
}
