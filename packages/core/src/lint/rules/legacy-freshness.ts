/**
 * `correctness/freshness` (§10.5) and its two repo-scoped siblings (registry freshness, repo-root
 * artifact freshness — the latter also the source of the `single-artifact-host` and
 * `root-artifact-collision` legacy codes). Each wraps the corresponding existing
 * `pipeline/validate.ts` function, which already bakes the CI/local severity distinction into the
 * `Finding` it returns (hard in CI, soft locally) — `findingToDiagnostic` carries that straight
 * through to `error`/`warn`.
 *
 * @see docs/specs/architecture.md §10.5
 */

import {
  checkFreshness,
  checkRegistryFreshness,
  checkRootArtifactFreshness,
} from '../../pipeline/validate.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, InternalRuleContext, Rule } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const FRESHNESS_ID = 'correctness/freshness';

/** Plugin-scoped freshness: in-plugin generated hook JSONs and `dist/**` bundle trees. */
export const pluginFreshnessRule: Rule = {
  meta: {
    id: FRESHNESS_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'Generated files (hook JSONs, dist bundles) match what `aipm build` would currently produce.',
    // Freshness needs the aipm workspace model (build-derived expected bytes) — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: InternalRuleContext): Diagnostic[] {
    if (ctx.skipFreshness) return [];
    const findings = checkFreshness(ctx.pluginDir, ctx.distDir, ctx.envelope, ctx.ci);
    return findings.map((f) =>
      findingToDiagnostic(f, FRESHNESS_ID, 'correctness', docsUrlFor(FRESHNESS_ID)),
    );
  },
};

/** Repo-scoped freshness: the generated marketplace registries. Requires `ctx.workspace`. */
export const registryFreshnessRule: Rule = {
  meta: {
    id: FRESHNESS_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'Generated marketplace registries match what `aipm build` would currently produce.',
    // Requires ctx.workspace (aipm.workspace.ts) — repo-scoped, aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: InternalRuleContext): Promise<Diagnostic[]> {
    if (ctx.workspace === undefined || ctx.skipFreshness) return [];
    const findings = await checkRegistryFreshness(
      ctx.repoRoot,
      ctx.allPluginDirs,
      ctx.workspace,
      ctx.ci,
      ctx.configCache,
    );
    return findings.map((f) =>
      findingToDiagnostic(f, FRESHNESS_ID, 'correctness', docsUrlFor(FRESHNESS_ID)),
    );
  },
};

const ROOT_ARTIFACT_ID = 'correctness/root-artifact-freshness';

/**
 * Repo-scoped: single-artifact-host root artifacts (gemini/kiro). Surfaces
 * `single-artifact-host` (always hard/error), `root-artifact-collision` (always hard/error), and
 * `freshness` (CI/local, via the wrapped function) findings — each finding's own `code` becomes
 * the diagnostic's `legacyCode`. Requires `ctx.workspace`.
 */
export const rootArtifactFreshnessRule: Rule = {
  meta: {
    id: ROOT_ARTIFACT_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'Single-artifact-host (gemini/kiro) repo-root artifacts are unambiguous, collision-free, and fresh.',
    // Requires ctx.workspace (aipm.workspace.ts) — repo-scoped, aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: InternalRuleContext): Promise<Diagnostic[]> {
    if (ctx.workspace === undefined) return [];
    const findings = await checkRootArtifactFreshness(
      ctx.repoRoot,
      ctx.allPluginDirs,
      ctx.workspace,
      ctx.ci,
      ctx.skipFreshness,
      ctx.configCache,
    );
    return findings.map((f) =>
      findingToDiagnostic(f, ROOT_ARTIFACT_ID, 'correctness', docsUrlFor(ROOT_ARTIFACT_ID)),
    );
  },
};
