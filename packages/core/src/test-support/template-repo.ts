import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Inputs to {@link resolveTemplateRepo}. All environment/filesystem access is injected so the
 * resolution policy can be unit-tested without a real checkout (the candidates and `exists`
 * probe are supplied by the caller).
 */
export interface TemplateRepoResolution {
  /** Value of the `AIPM_TEMPLATE_REPO` override, or `undefined`/empty when unset. */
  override?: string | undefined;
  /** Candidate checkout locations, probed in order, most-canonical first. */
  candidates: readonly string[];
  /** Existence probe — a location counts only if it looks like a real template checkout. */
  exists: (templateRoot: string) => boolean;
}

/**
 * Resolve which template checkout the parity fixtures should use, in priority order:
 *
 * 1. An explicit `AIPM_TEMPLATE_REPO` override is honored **verbatim** (no probing) — if it is
 *    wrong, the suite self-skips rather than silently using a different checkout.
 * 2. Otherwise the first candidate whose checkout {@link TemplateRepoResolution.exists exists}.
 * 3. Otherwise the first candidate, so `TEMPLATE_REPO` still names a sensible path for messages.
 *
 * Pure: no I/O of its own. The module-level {@link TEMPLATE_REPO} wires in the real env, candidate
 * locations, and filesystem probe.
 */
export function resolveTemplateRepo(resolution: TemplateRepoResolution): string {
  const { override, candidates, exists } = resolution;
  if (override !== undefined && override !== '') return override;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}

/** Directory of this source file, used to derive the source-relative candidate. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate template checkout locations, most-canonical first. The real checkout lives at
 * `ai-plugin-marketplace/template` — a sibling of this `tools` repo, NOT a `…-template` suffix.
 *
 * - The home-relative candidate matches the standard developer layout and is stable across git
 *   worktrees (worktrees nest under `tools/.worktrees/`, so the source-relative candidate below
 *   does not resolve to the sibling from inside one).
 * - The source-relative candidate (`<repoRoot>/../template`) covers clones placed outside
 *   `~/Development`, but only when running from the primary checkout rather than a worktree.
 */
export const TEMPLATE_REPO_CANDIDATES: readonly string[] = [
  path.join(os.homedir(), 'Development', 'ai-plugin-marketplace', 'template'),
  // HERE = …/tools/packages/core/src/test-support → five levels up is the repo's parent dir.
  path.resolve(HERE, '..', '..', '..', '..', '..', 'template'),
];

/**
 * Files the parity fixtures require to exist under `plugins/skill-evaluator/` in a *complete*
 * template checkout, relative to the template checkout root (i.e. each entry already includes
 * the `plugins/skill-evaluator/` prefix). This is deliberately the set the
 * bundlers must emit (README.md, LICENSE — see e.g. `targets/gemini/bundle.test.ts` "emitted
 * paths" assertions), not merely "has a `plugins/` directory".
 *
 * A checkout can satisfy the coarser "has `plugins/`" check while still being stale/incomplete —
 * e.g. cloned before README.md/LICENSE were added to the fixture plugin — which previously let
 * the parity suites run against a checkout that could never produce a passing result. Probing for
 * these files turns that into a clean skip instead of a hard fail.
 */
export const REQUIRED_SKILL_EVALUATOR_FILES: readonly string[] = [
  path.join('plugins', 'skill-evaluator', 'README.md'),
  path.join('plugins', 'skill-evaluator', 'LICENSE'),
];

/**
 * A location is a usable, *complete* template checkout when it contains a `plugins/` directory
 * AND every {@link REQUIRED_SKILL_EVALUATOR_FILES required fixture file} the parity suites depend
 * on. A `plugins/` directory alone is not sufficient — see {@link REQUIRED_SKILL_EVALUATOR_FILES}.
 */
export function templateIsComplete(templateRoot: string): boolean {
  if (!fs.existsSync(path.join(templateRoot, 'plugins'))) return false;
  return REQUIRED_SKILL_EVALUATOR_FILES.every((relPath) =>
    fs.existsSync(path.join(templateRoot, relPath)),
  );
}

/**
 * Absolute path to a local checkout of `ai-plugin-marketplace/template`, used by the
 * bootstrap golden-parity fixtures (architecture spec §13 Phase A exit criterion 1).
 *
 * These fixtures are developer-machine-only: they compare toolkit output against a real
 * template checkout and do not run in CI (the template isn't checked out there). Resolution is
 * {@link resolveTemplateRepo}: the `AIPM_TEMPLATE_REPO` environment variable overrides everything;
 * otherwise the first existing {@link TEMPLATE_REPO_CANDIDATES candidate} is used.
 *
 * Use `TEMPLATE_REPO_AVAILABLE` as a `describe.skipIf` guard so parity suites are
 * automatically skipped when the template checkout isn't present or is incomplete (e.g. in CI,
 * or a stale local clone missing README.md/LICENSE from the fixture plugin):
 *
 * ```ts
 * describe.skipIf(!TEMPLATE_REPO_AVAILABLE)('parity with skill-evaluator', () => { … })
 * ```
 */
export const TEMPLATE_REPO: string = resolveTemplateRepo({
  override: process.env['AIPM_TEMPLATE_REPO'],
  candidates: TEMPLATE_REPO_CANDIDATES,
  exists: templateIsComplete,
});

/**
 * True when the template checkout exists on disk AND is complete (see
 * {@link REQUIRED_SKILL_EVALUATOR_FILES}). Use as a `describe.skipIf` guard. Parity tests are
 * skipped both in CI (template repo not checked out) and locally against a stale/incomplete
 * checkout, rather than running and failing.
 */
export const TEMPLATE_REPO_AVAILABLE: boolean = templateIsComplete(TEMPLATE_REPO);
