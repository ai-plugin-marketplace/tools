/**
 * Scaffold templates for the Cursor target.
 *
 * `scaffoldCursorFiles` is a pure function returning the skeleton files this target contributes
 * to a new plugin. Cursor has no mechanical transform in v0.1.0, but it still owns a manifest
 * (`.cursor-plugin/plugin.json`). Every manifest carries `schemaVersion: "0.1.0"` (§12.2). No
 * generated-file sentinels — these are author-authored skeleton files (§4.3).
 *
 * Intentionally duplicated from the Claude scaffold rather than shared: per §3.4 no file in this
 * folder may import from a sibling target folder, and §13 Phase A keeps Cursor/Claude schemas
 * free to diverge later.
 *
 * @see docs/specs/architecture.md §4 (plugin source layout)
 * @see docs/specs/architecture.md §6.4 (compatibility-assist)
 * @see docs/specs/architecture.md §12.2 (schemaVersion on every manifest)
 * @see docs/specs/architecture.md §12.5 (per-target scaffold.ts)
 */

import {
  resolveDescription,
  SCHEMA_VERSION,
  type ScaffoldedFile,
  type TargetScaffoldOptions,
} from '../scaffold-kit.js';

/**
 * Produce the Cursor skeleton files for a plugin.
 *
 * The minimum required artifact (`TARGET_MIN_REQUIRED.cursor`) is `.cursor-plugin/plugin.json`.
 *
 * @param pluginName - Plugin identity; written verbatim as the manifest `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldCursorFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);
  const manifest: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    name: pluginName,
    version: '0.0.1',
    // `description` is optional and constrained to min length 1; omit it in placeholder mode
    // (add-target) so the skeleton stays schema-valid while leaving the field for the author.
    ...(description !== '' ? { description } : {}),
  };

  return [
    {
      path: '.cursor-plugin/plugin.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}
