/**
 * Scaffold templates for the Gemini CLI target.
 *
 * `scaffoldGeminiFiles` is a pure function returning the skeleton files this target contributes
 * to a new plugin: the `gemini-extension.json` manifest and its referenced `GEMINI.md` context
 * file. Every manifest carries `schemaVersion: "0.1.0"` (§12.2). No generated-file sentinels —
 * these are author-authored skeleton files (§4.3).
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
  SCHEMA_VERSION,
  type ScaffoldedFile,
  type TargetScaffoldOptions,
} from '../scaffold-kit.js';

/** Identity tag enabling editor highlighting of the embedded Markdown context file. */
const md = String.raw;

/**
 * Produce the Gemini CLI skeleton files for a plugin.
 *
 * The minimum required artifact (`TARGET_MIN_REQUIRED.gemini`) is `gemini-extension.json`. The
 * manifest declares `contextFileName: "GEMINI.md"`, so the companion `GEMINI.md` is emitted too.
 *
 * @param pluginName - Plugin identity; written verbatim as the manifest `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldGeminiFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);
  const manifest: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    name: pluginName,
    version: '0.0.1',
    description,
    contextFileName: 'GEMINI.md',
    mcpServers: {},
  };

  return [
    {
      path: 'gemini-extension.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: 'GEMINI.md',
      content: md`# ${pluginName}

${description}

## Overview

Describe what this plugin does for Gemini CLI users.
`,
    },
  ];
}
