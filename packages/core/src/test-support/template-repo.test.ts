/**
 * Tests for the template-checkout resolution policy (`resolveTemplateRepo`).
 *
 * Pure policy, exercised with injected candidates/override/probe so it runs in CI without a real
 * template checkout. Regression guard: the default candidate must point at the real checkout
 * (`ai-plugin-marketplace/template`, a `/template` subdir — NOT an `…-template` suffix). The
 * historical bug used the suffix, so `TEMPLATE_REPO_AVAILABLE` was always false and every parity
 * suite silently skipped.
 *
 * @see docs/specs/architecture.md §13 (Phase A exit criteria — bootstrap parity fixtures)
 */

import { describe, expect, it } from 'vitest';

import {
  resolveTemplateRepo,
  TEMPLATE_REPO_CANDIDATES,
  type TemplateRepoResolution,
} from './template-repo.js';

/** A resolution where only the listed `present` paths report as existing. */
function withPresent(
  present: readonly string[],
  rest: Omit<TemplateRepoResolution, 'exists'>,
): TemplateRepoResolution {
  return { ...rest, exists: (p) => present.includes(p) };
}

describe('resolveTemplateRepo', () => {
  const A = '/candidate/a';
  const B = '/candidate/b';

  it('honors a non-empty override verbatim, without probing candidates', () => {
    expect(
      resolveTemplateRepo({
        override: '/explicit/override',
        candidates: [A, B],
        // exists throws if consulted — proves the override path skips probing entirely.
        exists: () => {
          throw new Error('exists must not be called when an override is present');
        },
      }),
    ).toBe('/explicit/override');
  });

  it('uses the override even when it does not exist (suite self-skips rather than guessing)', () => {
    expect(
      resolveTemplateRepo(withPresent([A], { override: '/missing/override', candidates: [A, B] })),
    ).toBe('/missing/override');
  });

  it('treats an empty-string override as unset and falls through to candidates', () => {
    expect(resolveTemplateRepo(withPresent([B], { override: '', candidates: [A, B] }))).toBe(B);
  });

  it('treats an undefined override as unset', () => {
    expect(resolveTemplateRepo(withPresent([A], { override: undefined, candidates: [A, B] }))).toBe(
      A,
    );
  });

  it('returns the first candidate that exists, skipping earlier non-existent ones', () => {
    expect(resolveTemplateRepo(withPresent([B], { candidates: [A, B] }))).toBe(B);
  });

  it('prefers the earlier candidate when more than one exists', () => {
    expect(resolveTemplateRepo(withPresent([A, B], { candidates: [A, B] }))).toBe(A);
  });

  it('falls back to the first candidate when none exist (sensible path for error messages)', () => {
    expect(resolveTemplateRepo(withPresent([], { candidates: [A, B] }))).toBe(A);
  });

  it('returns the empty string when there are no candidates and no override (edge)', () => {
    expect(resolveTemplateRepo(withPresent([], { candidates: [] }))).toBe('');
  });
});

describe('TEMPLATE_REPO_CANDIDATES', () => {
  it('targets the real `ai-plugin-marketplace/template` checkout, not a `-template` suffix', () => {
    // Regression for the always-skip bug: the canonical candidate ends in `…/ai-plugin-marketplace/template`.
    expect(TEMPLATE_REPO_CANDIDATES[0]).toMatch(/[/\\]ai-plugin-marketplace[/\\]template$/);
    for (const candidate of TEMPLATE_REPO_CANDIDATES) {
      expect(candidate).not.toMatch(/ai-plugin-marketplace-template/);
    }
  });

  it('offers at least one candidate so resolution never returns the empty string in practice', () => {
    expect(TEMPLATE_REPO_CANDIDATES.length).toBeGreaterThan(0);
  });
});
