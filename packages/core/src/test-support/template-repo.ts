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
 * the `plugins/skill-evaluator/` prefix). This is deliberately the set the bundlers must emit
 * (`gemini-extension.json`/`GEMINI.md` for Gemini, `POWER.md`/`mcp.json` for Kiro — see e.g.
 * `targets/gemini/bundle.test.ts`/`targets/kiro/bundle.test.ts` "emitted paths" assertions), not
 * merely "has a `plugins/` directory".
 *
 * `README.md`/`LICENSE` are deliberately EXCLUDED from this list (issue #89): the template repo
 * (commit d2d9923, "adopt generated registries and repo-root Gemini/Kiro emission") moved them
 * from per-plugin source to the repo root, where they are canonical, author-owned, SHARED
 * artifacts the bundlers never copy (see `targets/gemini/bundle.ts`, `targets/kiro/bundle.ts`).
 * Requiring them here would make every current (post-d2d9923) checkout look permanently
 * incomplete.
 *
 * A checkout can satisfy the coarser "has `plugins/`" check while still being stale/incomplete —
 * e.g. cloned before these fixture files existed — which previously let the parity suites run
 * against a checkout that could never produce a passing result. Probing for these files turns
 * that into a clean skip instead of a hard fail.
 */
export const REQUIRED_SKILL_EVALUATOR_FILES: readonly string[] = [
  path.join('plugins', 'skill-evaluator', 'gemini-extension.json'),
  path.join('plugins', 'skill-evaluator', 'GEMINI.md'),
  path.join('plugins', 'skill-evaluator', 'POWER.md'),
  path.join('plugins', 'skill-evaluator', 'mcp.json'),
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
 * In CI, the `check` job checks out `ai-plugin-marketplace/template` at the SHA pinned in
 * `.github/template-repo.rev` and points `AIPM_TEMPLATE_REPO` at that checkout, so these
 * fixtures run with positive coverage there too (see {@link AIPM_REQUIRE_TEMPLATE}). Locally,
 * resolution is {@link resolveTemplateRepo}: the `AIPM_TEMPLATE_REPO` environment variable
 * overrides everything; otherwise the first existing {@link TEMPLATE_REPO_CANDIDATES candidate}
 * is used.
 *
 * Gate parity suites with {@link shouldSkipTemplateRepoSuite} + {@link assertTemplateRepoAvailable}
 * (not `TEMPLATE_REPO_AVAILABLE` alone), so behavior differs correctly by environment: locally
 * (no `AIPM_REQUIRE_TEMPLATE`), an unavailable/incomplete checkout skips with a reason (e.g. a
 * developer machine without the sibling checkout, or a stale local clone missing
 * README.md/LICENSE from the fixture plugin); under `AIPM_REQUIRE_TEMPLATE=1` (CI), the suite
 * does NOT skip — it runs and {@link assertTemplateRepoAvailable} throws a loud, actionable
 * error instead:
 *
 * ```ts
 * const skip = shouldSkipTemplateRepoSuite({ available: TEMPLATE_REPO_AVAILABLE, required: AIPM_REQUIRE_TEMPLATE });
 * describe.skipIf(skip)('parity with skill-evaluator', () => {
 *   beforeAll(() =>
 *     assertTemplateRepoAvailable({
 *       available: TEMPLATE_REPO_AVAILABLE,
 *       required: AIPM_REQUIRE_TEMPLATE,
 *       templateRoot: TEMPLATE_REPO,
 *     }),
 *   );
 *   // …
 * });
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
 * skipped both when no checkout is configured and locally against a stale/incomplete
 * checkout, rather than running and failing.
 */
export const TEMPLATE_REPO_AVAILABLE: boolean = templateIsComplete(TEMPLATE_REPO);

/**
 * True when `AIPM_REQUIRE_TEMPLATE=1` is set. CI's `check` job sets this after checking out the
 * pinned template revision, so a missing/incomplete checkout there is a hard failure rather than
 * a silent skip — see {@link shouldSkipTemplateRepoSuite} and {@link assertTemplateRepoAvailable}.
 * Local developer runs never set this, so the skip-with-reason behavior above is unchanged.
 */
export const AIPM_REQUIRE_TEMPLATE: boolean = process.env['AIPM_REQUIRE_TEMPLATE'] === '1';

/**
 * Inputs to {@link shouldSkipTemplateRepoSuite} and {@link assertTemplateRepoAvailable}. Injected
 * so the anti-regression-to-skip policy can be unit-tested without a real checkout or env vars.
 */
export interface TemplateRepoGuard {
  /** Whether the resolved template checkout is present and complete. */
  available: boolean;
  /** Whether the caller has opted into hard-failing on an unavailable checkout (CI). */
  required: boolean;
  /** The resolved checkout path, included in the thrown error for diagnostics. */
  templateRoot: string;
}

/**
 * Whether a `describe.skipIf` guard should skip a template-repo-gated parity suite.
 *
 * Skips only when the checkout is unavailable AND the caller has not opted into
 * {@link AIPM_REQUIRE_TEMPLATE}. When required and unavailable, the suite must NOT skip — it runs
 * so {@link assertTemplateRepoAvailable} (called from within the suite, e.g. a `beforeAll`) can
 * fail loudly instead.
 */
export function shouldSkipTemplateRepoSuite(
  guard: Pick<TemplateRepoGuard, 'available' | 'required'>,
): boolean {
  return !guard.available && !guard.required;
}

/**
 * Hard-fail guard for template-repo-gated parity suites: throws when the checkout is
 * unavailable/incomplete AND {@link AIPM_REQUIRE_TEMPLATE} is set, turning what would otherwise be
 * a silent skip into a loud CI failure (the anti-regression-to-skip guard — see issue #86).
 *
 * No-op when the checkout is available, or when it is unavailable but not required (the suite's
 * `describe.skipIf(shouldSkipTemplateRepoSuite(...))` will have skipped it in that case, so this
 * is never reached; the explicit no-op keeps the function safe to call unconditionally).
 */
export function assertTemplateRepoAvailable(guard: TemplateRepoGuard): void {
  if (guard.available || !guard.required) return;
  throw new Error(
    `AIPM_REQUIRE_TEMPLATE is set but the template checkout at "${guard.templateRoot}" is ` +
      'missing or incomplete (see REQUIRED_SKILL_EVALUATOR_FILES in template-repo.ts). ' +
      'This suite must run with positive coverage in CI, not skip — check that the ' +
      '`ai-plugin-marketplace/template` checkout step in .github/workflows/ci.yml succeeded ' +
      'and AIPM_TEMPLATE_REPO points at it.',
  );
}
