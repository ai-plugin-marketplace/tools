/**
 * Tests for `applyRuleSeverityOverrides` (L-D6, `aipm lint --rule <id>=<severity>`).
 *
 * @see docs/specs/lint-engine.md L-D6, §4.1
 */

import { describe, expect, it } from 'vitest';
import { applyRuleSeverityOverrides, unknownRuleOverrideDiagnostics } from './rule-overrides.js';
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

describe('unknownRuleOverrideDiagnostics()', () => {
  const registered = ['correctness/broken-file-ref', 'schema/target-conformance'];

  it('warns when an override ruleId matches neither a produced diagnostic nor a registered rule (typo)', () => {
    const result = unknownRuleOverrideDiagnostics(
      new Map([['correctness/borken-file-ref', 'off']]),
      [],
      registered,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      ruleId: 'config/unknown-rule',
      severity: 'warn',
      file: '(cli)',
    });
    expect(result[0]?.message).toContain("'correctness/borken-file-ref'");
  });

  it('does not warn for a registered rule that produced no diagnostics this run', () => {
    // The negative case L-D6 typo detection must not false-positive on: a real, valid rule id
    // that simply had nothing to report this run.
    const result = unknownRuleOverrideDiagnostics(
      new Map([['correctness/broken-file-ref', 'off']]),
      [],
      registered,
    );
    expect(result).toEqual([]);
  });

  it('does not warn for a ruleId that produced a diagnostic even if absent from the registry', () => {
    // Defensive OR-match: an override is accepted if it matches EITHER the static registry OR
    // something this run actually produced, in case the registry is ever incomplete.
    const produced = [diagnostic('agent-ux/some-new-rule', 'info')];
    const result = unknownRuleOverrideDiagnostics(
      new Map([['agent-ux/some-new-rule', 'error']]),
      produced,
      registered,
    );
    expect(result).toEqual([]);
  });

  it('checks against diagnostics from BEFORE severity overrides were applied', () => {
    // If checked against the post-filter list, overriding a rule to 'off' would remove its own
    // diagnostics and make the override look unmatched — a false positive on a real rule.
    const beforeOverrides = [diagnostic('correctness/broken-file-ref', 'error')];
    const result = unknownRuleOverrideDiagnostics(
      new Map([['correctness/broken-file-ref', 'off']]),
      beforeOverrides,
      [], // Not even in the registry — only the produced-diagnostic match should save it here.
    );
    expect(result).toEqual([]);
  });

  it('emits one warning per unmatched override, not one per diagnostic', () => {
    const result = unknownRuleOverrideDiagnostics(
      new Map([
        ['typo/one', 'off'],
        ['typo/two', 'warn'],
      ]),
      [],
      registered,
    );
    expect(result.map((d) => d.ruleId)).toEqual(['config/unknown-rule', 'config/unknown-rule']);
    expect(result).toHaveLength(2);
  });
});
