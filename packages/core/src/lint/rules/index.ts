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
 * Rules that need only a single plugin's `RuleContext` (envelope already resolved).
 * `envelopeShapeRule` is deliberately excluded — it runs before an envelope is resolved (see
 * `engine.ts`/`pipeline/validate.ts`).
 */
export const PER_PLUGIN_RULES: readonly Rule[] = [
  targetSchemaRule,
  envelopeAdherenceRule,
  frontmatterParsesRule,
  nameConsistencyRule,
  mcpKeySyncRule,
  marketplaceRegistrationRule,
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
