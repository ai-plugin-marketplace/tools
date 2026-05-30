import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Absolute path to a local checkout of `ai-plugin-marketplace/template`, used by the
 * bootstrap golden-parity fixtures (architecture spec §13 Phase A exit criterion 1).
 *
 * These fixtures are developer-machine-only: they compare toolkit output against a real
 * template checkout and do not run in CI (the template isn't checked out there). Override
 * the location with the `AIPM_TEMPLATE_REPO` environment variable.
 */
export const TEMPLATE_REPO: string =
  process.env.AIPM_TEMPLATE_REPO ??
  path.join(os.homedir(), 'Development', 'ai-plugin-marketplace-template');
