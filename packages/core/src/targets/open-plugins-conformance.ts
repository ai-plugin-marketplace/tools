/**
 * Shared Open Plugins conformance helpers.
 *
 * This module lives at `targets/` (not inside any single target folder), so importing it from a
 * `targets/<target>/…` file does NOT violate the cross-target-import rule (§3.4) — that rule forbids
 * importing from a *sibling target* folder, not from shared infrastructure (same status as
 * `scaffold-kit.ts`).
 *
 * It provides two things:
 *   1. The canonical Open Plugins `name` grammar (predicate + Zod schema), the single source of
 *      truth consumed by both the `open-plugins` target schema (where a violation is HARD) and the
 *      conformance advisories below (where the identical rule is SOFT on native targets).
 *   2. SOFT `open-plugins-conformance` advisory builders emitted by the native `claude`/`cursor`/
 *      `codex` validators. These are portability nudges — never hard, never flipping
 *      `ValidationResult.passed` (spec §7 / OP-D10). A native plugin that trips one is still fully
 *      valid for its declared targets; the advisory only says what Open Plugins would additionally
 *      want.
 *
 * @see docs/specs/open-plugins-target.md §7 (conformance-overlap advisories, OP-D10)
 * @see https://open-plugins.com/plugin-builders/specification.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

import type { Finding } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Open Plugins `name` grammar — the single source of truth
// ---------------------------------------------------------------------------

/** Maximum length of an Open Plugins `name` (spec §2.1). */
const OPEN_PLUGINS_NAME_MAX = 64;

/**
 * Char-class/anchor regex for the Open Plugins `name` grammar (spec §2.1): lowercase alphanumeric
 * plus `-`/`.`, with an alphanumeric start AND end. Equals Cursor's installed runtime regex
 * (empirical §5.2). The `--`/`..` prohibitions are applied separately in {@link isValidOpenPluginsName}.
 */
const OPEN_PLUGINS_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Whether `name` satisfies the full Open Plugins `name` grammar (spec §2.1): 1–64 chars, lowercase
 * alphanumeric plus `-` and `.`, alphanumeric start AND end, no consecutive `--`, no consecutive `..`.
 * A single character is legal.
 */
export function isValidOpenPluginsName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= OPEN_PLUGINS_NAME_MAX &&
    OPEN_PLUGINS_NAME_RE.test(name) &&
    !name.includes('--') &&
    !name.includes('..')
  );
}

/**
 * Zod schema for an Open Plugins `name` (spec §2.1), built from {@link isValidOpenPluginsName} so
 * the schema and the advisory predicate can never drift. Consumed by the `open-plugins` target
 * schema (where a violation is a HARD `schema-invalid`).
 */
export const openPluginsNameSchema = z
  .string()
  .refine(
    isValidOpenPluginsName,
    'name must be a valid Open Plugins name: 1–64 lowercase alphanumeric characters plus "-"/".", ' +
      'starting and ending alphanumeric, with no "--" or ".."',
  );

// ---------------------------------------------------------------------------
// Soft advisory builder
// ---------------------------------------------------------------------------

/**
 * Build a SOFT `open-plugins-conformance` finding. Always soft — it must never flip
 * `ValidationResult.passed` (spec §7).
 */
function conformanceAdvisory(pluginName: string, message: string, hint: string): Finding {
  return { severity: 'soft', code: 'open-plugins-conformance', plugin: pluginName, message, hint };
}

// ---------------------------------------------------------------------------
// Name-grammar drift advisory (spec §7)
// ---------------------------------------------------------------------------

/**
 * Advise (SOFT) when a native manifest `name` is legal for its target but violates the Open Plugins
 * name grammar — e.g. `a--b` or `abc-`, which the native scaffold-slug regex (`^[a-z][a-z0-9-]*$`)
 * accepts but Open Plugins rejects. Emits nothing when the name is absent, non-string, or already
 * Open-Plugins-valid.
 *
 * @param pluginName - Plugin identity for the finding's `plugin` field.
 * @param manifestRel - Relative manifest path for the message (e.g. `.claude-plugin/plugin.json`).
 * @param name - The manifest's declared `name` (read leniently from the raw JSON).
 */
export function nameGrammarConformanceFindings(
  pluginName: string,
  manifestRel: string,
  name: unknown,
): Finding[] {
  if (typeof name !== 'string' || isValidOpenPluginsName(name)) return [];
  return [
    conformanceAdvisory(
      pluginName,
      `${manifestRel}: name '${name}' is valid for your declared targets but is not a legal Open Plugins name (Open Plugins forbids "--"/".." and requires an alphanumeric start and end, max 64 chars).`,
      'To keep the plugin portable to Open Plugins, rename it to a value that also satisfies the Open Plugins grammar (the toolkit scaffold slug already does).',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Metadata-dir isolation advisory (spec §7)
// ---------------------------------------------------------------------------

/**
 * Advise (SOFT) when a plugin's vendor metadata directory (`vendorDir`, e.g. `.claude-plugin`)
 * contains any entry other than `plugin.json`. Open Plugins requires the metadata directory to hold
 * only `plugin.json` (spec §2.1); this nudges a native plugin toward that isolation without ever
 * failing it.
 *
 * Scoped to the PLUGIN-level vendor dir only — the repo-root registry dirs (which legitimately hold
 * a `marketplace.json`) are never inspected here.
 *
 * @param pluginDir - Absolute plugin directory.
 * @param vendorDir - The plugin-level vendor metadata dir name (e.g. `.claude-plugin`).
 * @param pluginName - Plugin identity for the finding's `plugin` field.
 */
export function metadataDirConformanceFindings(
  pluginDir: string,
  vendorDir: string,
  pluginName: string,
): Finding[] {
  const dir = path.join(pluginDir, vendorDir);
  if (!fs.existsSync(dir)) return [];

  // A readdir failure is reported as an advisory rather than silently skipped, mirroring the HARD
  // metadata-dir-isolation check inside the open-plugins target: `vendorDir` existing as a FILE
  // (ENOTDIR), or an unreadable dir, means its Open Plugins isolation cannot be shown to hold. Kept
  // SOFT here because a native plugin still owes Open Plugins nothing.
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const isNotDir = code === 'ENOTDIR';
    return [
      conformanceAdvisory(
        pluginName,
        isNotDir
          ? `${vendorDir} exists but is not a directory. Open Plugins expects the plugin's metadata directory to be a directory holding only plugin.json.`
          : `${vendorDir}/ could not be read (${code ?? 'unknown error'}), so its Open Plugins metadata-dir isolation cannot be verified.`,
        isNotDir
          ? `Replace the ${vendorDir} file with a ${vendorDir}/ directory holding plugin.json.`
          : `Fix the permissions so ${vendorDir}/ is readable.`,
      ),
    ];
  }

  const extras = entries.filter((e) => e !== 'plugin.json').sort();
  if (extras.length === 0) return [];

  return [
    conformanceAdvisory(
      pluginName,
      `${vendorDir}/ contains ${extras.join(', ')} besides plugin.json. This is fine for your declared targets, but Open Plugins requires the plugin's metadata directory to hold only plugin.json.`,
      `Move ${extras.length === 1 ? 'that entry' : 'those entries'} out of ${vendorDir}/ to keep the plugin Open-Plugins-conformant.`,
    ),
  ];
}
