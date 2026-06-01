import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Absolute path to a local checkout of `ai-plugin-marketplace/template`, used by the
 * bootstrap golden-parity fixtures (architecture spec §13 Phase A exit criterion 1).
 *
 * These fixtures are developer-machine-only: they compare toolkit output against a real
 * template checkout and do not run in CI (the template isn't checked out there). Override
 * the location with the `AIPM_TEMPLATE_REPO` environment variable.
 *
 * Use `TEMPLATE_REPO_AVAILABLE` as a `describe.skipIf` guard so parity suites are
 * automatically skipped when the template checkout isn't present (e.g. in CI):
 *
 * ```ts
 * describe.skipIf(!TEMPLATE_REPO_AVAILABLE)('parity with skill-evaluator', () => { … })
 * ```
 */
export const TEMPLATE_REPO: string =
  process.env['AIPM_TEMPLATE_REPO'] ??
  path.join(os.homedir(), 'Development', 'ai-plugin-marketplace-template');

/**
 * True when the template checkout exists on disk. Use as a `describe.skipIf` guard.
 * Parity tests are skipped in CI where the template repo is not checked out.
 */
export const TEMPLATE_REPO_AVAILABLE: boolean = fs.existsSync(
  path.join(TEMPLATE_REPO, 'plugins'),
);
