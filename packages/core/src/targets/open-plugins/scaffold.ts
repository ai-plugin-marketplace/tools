/**
 * Scaffold templates for the Open Plugins target.
 *
 * `scaffoldOpenPluginsFiles` is a pure function returning the skeleton files this target
 * contributes to a new plugin. Open Plugins is an in-place marketplace target like Cursor/Codex: it
 * has no mechanical transform, but it still owns a manifest (`.plugin/plugin.json`). Every manifest
 * carries `schemaVersion: "0.1.0"` (§12.2). No generated-file sentinels — these are author-authored
 * skeleton files (§4.3).
 *
 * The emitted `name` uses the toolkit scaffold slug, which is a strict subset of the Open Plugins
 * name grammar (spec §4.2, OP-D7), so every scaffolded manifest is Open-Plugins-valid by
 * construction.
 *
 * Intentionally duplicated from the Codex/Cursor scaffold rather than shared: per §3.4 no file in
 * this folder may import from a sibling target folder, and §13 Phase A keeps target schemas free to
 * diverge later.
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see docs/specs/architecture.md §4 (plugin source layout)
 * @see docs/specs/architecture.md §12.2 (schemaVersion on every manifest)
 * @see docs/specs/architecture.md §12.5 (per-target scaffold.ts)
 */

import {
  resolveDescription,
  INITIAL_PLUGIN_VERSION,
  SCHEMA_VERSION,
  type ScaffoldedFile,
  type TargetScaffoldOptions,
} from '../scaffold-kit.js';

/**
 * Produce the Open Plugins skeleton files for a plugin.
 *
 * The minimum required artifact (`TARGET_MIN_REQUIRED['open-plugins']`) is `.plugin/plugin.json`.
 *
 * @param pluginName - Plugin identity; written verbatim as the manifest `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldOpenPluginsFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);
  const manifest: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    name: pluginName,
    version: INITIAL_PLUGIN_VERSION,
    // `description` is optional; omit it in placeholder mode (add-target) so the skeleton stays
    // schema-valid while leaving the field for the author.
    ...(description !== '' ? { description } : {}),
  };

  return [
    {
      path: '.plugin/plugin.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}
