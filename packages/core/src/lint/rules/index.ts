/** All rules the engine knows about, migrated-legacy and new. */

import type { Rule } from '../types.js';
import { brokenFileRefRule } from './broken-file-ref.js';
import { duplicateComponentNameRule } from './duplicate-component-name.js';
import { invalidMatcherRule } from './invalid-matcher.js';
import {
  defaultMarketplaceNameRule,
  envelopeAdherenceRule,
  frontmatterParsesRule,
  marketplaceRegistrationRule,
  mcpKeySyncRule,
  nameConsistencyRule,
} from './legacy-correctness.js';
import { envelopeShapeRule } from './legacy-envelope-shape.js';
import {
  pluginFreshnessRule,
  registryFreshnessRule,
  rootArtifactFreshnessRule,
} from './legacy-freshness.js';
import { targetSchemaRule } from './legacy-schema.js';
import { unknownHookEventRule } from './unknown-hook-event.js';

// Re-exported for `pipeline/validate.ts`'s direct-rule-invocation wiring; the four new §3.2
// rules (brokenFileRefRule et al.) are consumed only via `PER_PLUGIN_RULES` (below) and directly
// by their own module's tests, so they are intentionally not re-exported here.
export {
  defaultMarketplaceNameRule,
  envelopeAdherenceRule,
  envelopeShapeRule,
  frontmatterParsesRule,
  marketplaceRegistrationRule,
  mcpKeySyncRule,
  nameConsistencyRule,
  pluginFreshnessRule,
  registryFreshnessRule,
  rootArtifactFreshnessRule,
  targetSchemaRule,
};

/**
 * Per-plugin rules that run unconditionally (envelope already resolved, no cross-target gating).
 * `envelopeShapeRule` is deliberately excluded — it runs before an envelope is resolved (see
 * `engine.ts`/`pipeline/validate.ts`). `targetSchemaRule` is also excluded from this list — the
 * engine runs it first and separately so it can compute `hasBlockingSchemaError` from its own
 * diagnostics, exactly as `pipeline/validate.ts`'s `runValidate` does.
 *
 * The three cross-target consistency rules (`nameConsistencyRule`, `mcpKeySyncRule`,
 * `marketplaceRegistrationRule`) are intentionally NOT in this array — `validate()` only runs
 * them when `envelope.length > 1 && !hasBlockingSchemaError` (and skips marketplace-registration
 * entirely when registry generation is opted in), per §10.1 step 4 / §10.3. `engine.ts`'s `lint()`
 * replicates that exact gating rather than running them unconditionally, so `lint()` and
 * `validate()` agree on when these fire (avoiding e.g. a double-report against the
 * registry-freshness-owned diagnostic when `aipm.workspace.ts` is present).
 */
export const PER_PLUGIN_RULES: readonly Rule[] = [
  envelopeAdherenceRule,
  frontmatterParsesRule,
  pluginFreshnessRule,
  brokenFileRefRule,
  unknownHookEventRule,
  invalidMatcherRule,
  duplicateComponentNameRule,
];

/** Rules scoped to the whole repo, run once (not per plugin). */
export const REPO_SCOPED_RULES: readonly Rule[] = [
  defaultMarketplaceNameRule,
  registryFreshnessRule,
  rootArtifactFreshnessRule,
];
