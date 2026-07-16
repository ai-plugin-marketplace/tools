/**
 * Tests for `Diagnostic` ⇄ `Finding` conversion (L-D2).
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import { describe, expect, it } from 'vitest';
import type { Finding } from '../pipeline/types.js';
import { diagnosticToFinding, findingToDiagnostic } from './diagnostic.js';
import type { Diagnostic } from './types.js';

describe('findingToDiagnostic()', () => {
  it('maps a hard Finding to an error-severity Diagnostic carrying legacyCode', () => {
    const finding: Finding = {
      severity: 'hard',
      code: 'schema-invalid',
      plugin: 'my-plugin',
      message: 'bad manifest',
      hint: 'fix it',
    };
    expect(
      findingToDiagnostic(finding, 'schema/target-conformance', 'schema', 'https://x/y'),
    ).toEqual({
      ruleId: 'schema/target-conformance',
      category: 'schema',
      severity: 'error',
      message: 'bad manifest',
      file: 'my-plugin',
      docsUrl: 'https://x/y',
      legacyCode: 'schema-invalid',
      hint: 'fix it',
    });
  });

  it('maps a soft Finding to a warn-severity Diagnostic, omitting hint when absent', () => {
    const finding: Finding = {
      severity: 'soft',
      code: 'default-marketplace-name',
      message: 'placeholder name',
    };
    const diagnostic = findingToDiagnostic(
      finding,
      'correctness/default-marketplace-name',
      'correctness',
      'https://x/y',
    );
    expect(diagnostic.severity).toBe('warn');
    expect(diagnostic.hint).toBeUndefined();
    // A repo-scoped Finding has no `plugin` — file falls back to the '(repo)' sentinel.
    expect(diagnostic.file).toBe('(repo)');
  });
});

describe('diagnosticToFinding()', () => {
  function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
    return {
      ruleId: 'correctness/freshness',
      category: 'correctness',
      severity: 'warn',
      message: 'stale',
      file: 'my-plugin',
      docsUrl: 'https://x/y',
      legacyCode: 'freshness',
      ...overrides,
    };
  }

  it('maps error severity to hard', () => {
    const finding = diagnosticToFinding(
      diagnostic({ severity: 'error', legacyCode: 'schema-invalid' }),
      false,
    );
    expect(finding.severity).toBe('hard');
  });

  it('maps warn severity to soft outside CI', () => {
    const finding = diagnosticToFinding(diagnostic({ severity: 'warn' }), false);
    expect(finding.severity).toBe('soft');
  });

  it('maps info severity to soft', () => {
    const finding = diagnosticToFinding(
      diagnostic({ severity: 'info', legacyCode: 'default-marketplace-name' }),
      false,
    );
    expect(finding.severity).toBe('soft');
  });

  it('escalates a freshness diagnostic to hard in CI (§10.2)', () => {
    const finding = diagnosticToFinding(
      diagnostic({ severity: 'warn', legacyCode: 'freshness' }),
      true,
    );
    expect(finding.severity).toBe('hard');
  });

  it('does NOT escalate a non-freshness diagnostic in CI', () => {
    const finding = diagnosticToFinding(
      diagnostic({ severity: 'warn', legacyCode: 'default-marketplace-name' }),
      true,
    );
    expect(finding.severity).toBe('soft');
  });

  it('preserves message, hint, and code; maps the "(repo)" file sentinel back to no `plugin`', () => {
    const finding = diagnosticToFinding(
      diagnostic({ message: 'msg', hint: 'hint', file: '(repo)', legacyCode: 'freshness' }),
      false,
    );
    expect(finding).toEqual({ severity: 'soft', code: 'freshness', message: 'msg', hint: 'hint' });
  });

  it('round-trips a Finding through findingToDiagnostic → diagnosticToFinding unchanged', () => {
    const original: Finding = {
      severity: 'hard',
      code: 'envelope-adherence',
      plugin: 'my-plugin',
      message: 'missing artifact',
      hint: 'create it',
    };
    const roundTripped = diagnosticToFinding(
      findingToDiagnostic(original, 'correctness/envelope-adherence', 'correctness', 'https://x/y'),
      false,
    );
    expect(roundTripped).toEqual(original);
  });

  it('throws for a diagnostic with no legacyCode (programmer error, not user input)', () => {
    const noLegacyCode: Diagnostic = {
      ruleId: 'correctness/broken-file-ref',
      category: 'correctness',
      severity: 'error',
      message: 'broken ref',
      file: 'my-plugin',
      docsUrl: 'https://x/y',
    };
    expect(() => diagnosticToFinding(noLegacyCode, false)).toThrow(/no legacyCode/);
  });
});
