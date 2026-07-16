/**
 * Tests for `applyRuleSeverityOverrides` (L-D6, `aipm lint --rule <id>=<severity>`).
 *
 * @see docs/specs/lint-engine.md L-D6, §4.1
 */

import { describe, expect, it } from 'vitest';
import { applyRuleSeverityOverrides } from './rule-overrides.js';
import type { Diagnostic } from './types.js';

function diagnostic(ruleId: string, severity: Diagnostic['severity']): Diagnostic {
  return {
    ruleId,
    category: 'correctness',
    severity,
    message: `${ruleId} message`,
    file: 'plugins/x/plugin.json',
    docsUrl: `https://example.com/rules/${ruleId}`,
  };
}

describe('applyRuleSeverityOverrides()', () => {
  it('passes diagnostics through unchanged when no override matches their ruleId', () => {
    const diagnostics = [diagnostic('correctness/broken-file-ref', 'warn')];
    expect(applyRuleSeverityOverrides(diagnostics, new Map())).toEqual(diagnostics);
  });

  it('replaces severity for a matching override', () => {
    const diagnostics = [diagnostic('correctness/broken-file-ref', 'warn')];
    const result = applyRuleSeverityOverrides(
      diagnostics,
      new Map([['correctness/broken-file-ref', 'error']]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe('error');
  });

  it('drops diagnostics whose rule is overridden to off', () => {
    const diagnostics = [
      diagnostic('correctness/broken-file-ref', 'warn'),
      diagnostic('schema/target-conformance', 'error'),
    ];
    const result = applyRuleSeverityOverrides(
      diagnostics,
      new Map([['correctness/broken-file-ref', 'off']]),
    );
    expect(result).toEqual([diagnostics[1]]);
  });

  it('preserves original diagnostic order across mixed override outcomes', () => {
    const diagnostics = [
      diagnostic('a/one', 'warn'),
      diagnostic('b/two', 'error'),
      diagnostic('c/three', 'info'),
    ];
    const result = applyRuleSeverityOverrides(
      diagnostics,
      new Map([
        ['b/two', 'off'],
        ['c/three', 'warn'],
      ]),
    );
    expect(result.map((d) => d.ruleId)).toEqual(['a/one', 'c/three']);
    expect(result[1]?.severity).toBe('warn');
  });

  // Negative: an override severity value is only ever what the CLI parsed (RuleSeverityOverride),
  // but 'off' specifically must never leak through as a Diagnostic.severity — this guards the
  // filter branch rather than the type system (see negative-test-consideration rule).
  it('never emits a diagnostic with severity off even if the type were widened', () => {
    const diagnostics = [diagnostic('a/one', 'error')];
    const result = applyRuleSeverityOverrides(diagnostics, new Map([['a/one', 'off']]));
    expect(result).toEqual([]);
  });
});
