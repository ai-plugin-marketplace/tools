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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertTemplateRepoAvailable,
  REQUIRED_SKILL_EVALUATOR_FILES,
  resolveTemplateRepo,
  shouldSkipTemplateRepoSuite,
  TEMPLATE_REPO_CANDIDATES,
  templateIsComplete,
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

describe('templateIsComplete', () => {
  // Issue #82: a checkout that merely HAS a `plugins/` dir is not necessarily a complete,
  // current checkout — a stale local clone can be missing files the parity fixtures require
  // (e.g. README.md/LICENSE for plugins/skill-evaluator), which previously let the coarser
  // "has plugins/" guard run the parity suites against a fixture that could never pass.
  let templateRoot: string;

  beforeEach(() => {
    templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'template-repo-completeness-'));
  });

  afterEach(() => {
    fs.rmSync(templateRoot, { recursive: true, force: true });
  });

  it('returns false when the checkout has no `plugins/` directory at all', () => {
    expect(templateIsComplete(templateRoot)).toBe(false);
  });

  it('returns false when `plugins/` exists but required fixture files are missing (issue #82)', () => {
    fs.mkdirSync(path.join(templateRoot, 'plugins', 'skill-evaluator'), { recursive: true });
    // Deliberately do not write README.md/LICENSE — reproduces the stale-checkout scenario.

    expect(templateIsComplete(templateRoot)).toBe(false);
  });

  it('returns false when only some of the required fixture files are present', () => {
    const pluginDir = path.join(templateRoot, 'plugins', 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'README.md'), '# skill-evaluator\n');
    // LICENSE still missing.

    expect(templateIsComplete(templateRoot)).toBe(false);
  });

  it('returns true when `plugins/` exists and every required fixture file is present', () => {
    const pluginDir = path.join(templateRoot, 'plugins', 'skill-evaluator');
    fs.mkdirSync(pluginDir, { recursive: true });
    for (const relPath of REQUIRED_SKILL_EVALUATOR_FILES) {
      fs.writeFileSync(path.join(templateRoot, relPath), 'placeholder\n');
    }

    expect(templateIsComplete(templateRoot)).toBe(true);
  });
});

// Issue #86: CI opts into AIPM_REQUIRE_TEMPLATE so a missing/incomplete template checkout is a
// hard failure there, while local runs keep the skip-with-reason behavior above unchanged.
describe('shouldSkipTemplateRepoSuite', () => {
  it('skips when the checkout is unavailable and not required (local default)', () => {
    expect(shouldSkipTemplateRepoSuite({ available: false, required: false })).toBe(true);
  });

  it('does not skip when the checkout is unavailable but required (CI must fail loudly, not skip)', () => {
    expect(shouldSkipTemplateRepoSuite({ available: false, required: true })).toBe(false);
  });

  it('does not skip when the checkout is available, regardless of required', () => {
    expect(shouldSkipTemplateRepoSuite({ available: true, required: false })).toBe(false);
    expect(shouldSkipTemplateRepoSuite({ available: true, required: true })).toBe(false);
  });
});

describe('assertTemplateRepoAvailable', () => {
  it('throws when the checkout is unavailable and required (the CI hard-fail case)', () => {
    expect(() => {
      assertTemplateRepoAvailable({
        available: false,
        required: true,
        templateRoot: '/some/checkout',
      });
    }).toThrow(/AIPM_REQUIRE_TEMPLATE/);
  });

  it('includes the template root in the thrown error for diagnostics', () => {
    expect(() => {
      assertTemplateRepoAvailable({
        available: false,
        required: true,
        templateRoot: '/some/checkout',
      });
    }).toThrow(/\/some\/checkout/);
  });

  it('does not throw when the checkout is unavailable but not required (local skip case)', () => {
    expect(() => {
      assertTemplateRepoAvailable({
        available: false,
        required: false,
        templateRoot: '/some/checkout',
      });
    }).not.toThrow();
  });

  it('does not throw when the checkout is available, regardless of required', () => {
    expect(() => {
      assertTemplateRepoAvailable({
        available: true,
        required: false,
        templateRoot: '/some/checkout',
      });
    }).not.toThrow();
    expect(() => {
      assertTemplateRepoAvailable({
        available: true,
        required: true,
        templateRoot: '/some/checkout',
      });
    }).not.toThrow();
  });
});
