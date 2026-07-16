/**
 * Static rule registry, backing `--rule <id>=<severity>` typo detection (L-D6).
 *
 * @see docs/specs/lint-engine.md L-D4, L-D6
 */

import { ALL_RULES } from './rules/index.js';

/**
 * Every rule id the engine knows about (spec L-D4's `Rule.meta.id`), regardless of whether a
 * given lint invocation actually runs it — `lint()`'s cross-target/discovery gating still applies
 * at run time, this is the static registry. Backs `aipm lint --rule <id>=<severity>` typo
 * detection: L-D6 says an unknown rule id in config/overrides is itself a `warn` diagnostic.
 *
 * @public
 */
export function registeredRuleIds(): readonly string[] {
  return ALL_RULES.map((rule) => rule.meta.id);
}
