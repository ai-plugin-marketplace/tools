/**
 * Diagnostic ⇄ Finding conversion (L-D2).
 *
 * `Finding`/`FindingCode` remain public API. `validate()` is a profile over the engine: every
 * legacy check is a rule carrying its `legacyCode`, and `diagnosticToFinding()` is the pure
 * mapping back — same codes, severities via `error → hard` / `warn|info → soft`, with the CI
 * freshness escalation preserved.
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import type { Finding, FindingCode } from '../pipeline/types.js';
import type { Diagnostic } from './types.js';

/**
 * Convert a legacy `Finding` into a `Diagnostic` carrying its `legacyCode`. Internal — this is
 * the inverse of {@link diagnosticToFinding}, used by rule wrappers that reuse an existing
 * `validate()` check's logic verbatim.
 *
 * `hard` → `'error'`, `soft` → `'warn'` (the reverse of {@link diagnosticToFinding}'s mapping, so
 * a `Finding` round-tripped through `findingToDiagnostic` → `diagnosticToFinding` reproduces the
 * original severity exactly).
 */
export function findingToDiagnostic(
  finding: Finding,
  ruleId: string,
  category: Diagnostic['category'],
  docsUrl: string,
): Diagnostic {
  return {
    ruleId,
    category,
    severity: finding.severity === 'hard' ? 'error' : 'warn',
    message: finding.message,
    file: finding.plugin ?? '(repo)',
    docsUrl,
    legacyCode: finding.code,
    ...(finding.hint !== undefined ? { hint: finding.hint } : {}),
  };
}

/**
 * Pure mapping from a `Diagnostic` back to a `Finding` (L-D2). `error` → `hard`; `warn` and
 * `info` → `soft`. The one exception is the freshness check's CI escalation (§10.2): a
 * `freshness`-coded diagnostic at `warn` severity becomes `hard` when `ci` is true, mirroring the
 * legacy `freshnessFinding()` behavior of `pipeline/validate.ts`.
 */
export function diagnosticToFinding(diagnostic: Diagnostic, ci: boolean): Finding {
  const code: FindingCode = diagnostic.legacyCode ?? assertLegacyCode(diagnostic);
  const isCiEscalatedFreshness = code === 'freshness' && diagnostic.severity !== 'error' && ci;
  const severity: Finding['severity'] =
    diagnostic.severity === 'error' || isCiEscalatedFreshness ? 'hard' : 'soft';

  const plugin = diagnostic.file === '(repo)' ? undefined : diagnostic.file;

  return {
    severity,
    code,
    ...(plugin !== undefined ? { plugin } : {}),
    message: diagnostic.message,
    ...(diagnostic.hint !== undefined ? { hint: diagnostic.hint } : {}),
  };
}

/**
 * `diagnosticToFinding` is only ever called on diagnostics produced by a legacy-migrated rule
 * (which always sets `legacyCode`); this narrows the type without a runtime cast and fails loudly
 * if a caller passes a diagnostic that has no legacy mapping.
 */
function assertLegacyCode(diagnostic: Diagnostic): never {
  throw new Error(
    `diagnosticToFinding: diagnostic '${diagnostic.ruleId}' has no legacyCode and cannot be mapped to a Finding.`,
  );
}
