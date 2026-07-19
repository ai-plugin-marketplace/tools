/**
 * Scaffold templates for the Claude Code target.
 *
 * `scaffoldClaudeFiles` is a pure function: it returns the skeleton files this target
 * contributes to a new plugin (relative paths + content) without touching the filesystem.
 * The pipeline orchestrator (`pipeline/scaffold.ts`) performs the actual writes.
 *
 * Every manifest carries `schemaVersion: "0.1.0"` per §12.2. Content is intentionally minimal
 * but valid against `claudePluginManifestSchema`. No generated-file sentinels are emitted — these
 * are author-authored skeleton files, not toolkit-generated artifacts (§4.3).
 *
 * This module must not import from any sibling targets/<other>/ folder (§3.4).
 *
 * @see docs/specs/architecture.md §4 (plugin source layout)
 * @see docs/specs/architecture.md §6.4 (compatibility-assist)
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
 * Produce the Claude Code skeleton files for a plugin.
 *
 * The minimum required artifact (§6.2, mirrored by `TARGET_MIN_REQUIRED.claude`) is
 * `.claude-plugin/plugin.json`. The manifest is kept minimal — no `hooks`/`mcpServers` paths are
 * declared, so no companion files are required to keep it valid.
 *
 * @param pluginName - Plugin identity; written verbatim as the manifest `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldClaudeFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);
  const manifest: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    name: pluginName,
    version: INITIAL_PLUGIN_VERSION,
    // `description` is optional and constrained to min length 1; omit it in placeholder mode
    // (add-target) so the skeleton stays schema-valid while leaving the field for the author.
    ...(description !== '' ? { description } : {}),
  };

  return [
    {
      path: '.claude-plugin/plugin.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}
