/**
 * Tests for `registeredRuleIds()` — the static rule registry backing `--rule` typo detection
 * (L-D6).
 *
 * @see docs/specs/lint-engine.md L-D4, L-D6
 */

import { describe, expect, it } from 'vitest';
import { registeredRuleIds } from './registered-rules.js';

describe('registeredRuleIds()', () => {
  it('includes rules that only ever run via cross-target gating or before envelope resolution', () => {
    const ids = registeredRuleIds();
    // These are excluded from PER_PLUGIN_RULES/REPO_SCOPED_RULES for gating reasons (see
    // rules/index.ts), not because they're not real rules — the registry must still include them.
    expect(ids).toContain('schema/envelope-shape');
    expect(ids).toContain('schema/target-conformance');
    expect(ids).toContain('correctness/name-consistency');
    expect(ids).toContain('correctness/version-consistency');
    expect(ids).toContain('correctness/mcp-key-sync');
    expect(ids).toContain('correctness/marketplace-registration');
  });

  it('includes an ordinary per-plugin and repo-scoped rule', () => {
    const ids = registeredRuleIds();
    expect(ids).toContain('correctness/broken-file-ref');
    expect(ids).toContain('correctness/default-marketplace-name');
  });

  it('has no duplicate ids other than the intentional plugin/registry freshness pair', () => {
    const ids = registeredRuleIds();
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    // pluginFreshnessRule and registryFreshnessRule share 'correctness/freshness' by design
    // (same check, different scope — see legacy-freshness.ts); every other id is unique.
    expect(duplicates).toEqual(['correctness/freshness']);
  });
});
