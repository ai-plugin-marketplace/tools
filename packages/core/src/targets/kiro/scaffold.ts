/**
 * Scaffold templates for the Kiro target.
 *
 * `scaffoldKiroFiles` is a pure function returning the skeleton files this target contributes to
 * a new plugin: `POWER.md`, a Markdown file whose YAML frontmatter is Kiro's plugin manifest.
 * The frontmatter carries `schemaVersion: "0.1.0"` (§12.2). No generated-file sentinels — this is
 * an author-authored skeleton file (§4.3).
 *
 * This module must not import from any sibling targets/<other>/ folder (§3.4).
 *
 * @see docs/specs/architecture.md §4 (plugin source layout)
 * @see docs/specs/architecture.md §6.4 (compatibility-assist)
 * @see docs/specs/architecture.md §12.2 (schemaVersion on every manifest)
 * @see docs/specs/architecture.md §12.5 (per-target scaffold.ts)
 */

import {
  INITIAL_PLUGIN_VERSION,
  resolveDescription,
  SCHEMA_VERSION,
  type ScaffoldedFile,
  type TargetScaffoldOptions,
} from '../scaffold-kit.js';

/** Identity tag enabling editor highlighting of the embedded Markdown body. */
const md = String.raw;

/**
 * A single literal backtick character, for interpolation into `md`-tagged templates.
 *
 * `md` is `String.raw`, so it does NOT interpret escape sequences — a `` \` `` inside a raw
 * template stays as the two literal characters backslash+backtick in the output (never becomes a
 * real backtick byte `0x60`). To embed an actual backtick in raw-tagged Markdown, interpolate this
 * constant instead of writing an escaped backtick in the template source.
 */
const bt = '`';

/**
 * Produce the Kiro skeleton files for a plugin.
 *
 * The minimum required artifact (`TARGET_MIN_REQUIRED.kiro`) is `POWER.md`. Its frontmatter
 * satisfies `kiroPowerMdFrontmatterSchema` (`name`, `description`, `version` all required).
 *
 * @param pluginName - Plugin identity; written verbatim as the frontmatter `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldKiroFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);

  // Frontmatter requires `description` to be present (not optional). In placeholder mode we emit
  // an empty value, leaving the field for the author per §6.4. JSON.stringify on the value keeps
  // the YAML scalar correctly quoted/escaped regardless of content.
  const content = md`---
schemaVersion: ${SCHEMA_VERSION}
name: ${pluginName}
description: ${JSON.stringify(description)}
version: ${INITIAL_PLUGIN_VERSION}
---

# ${pluginName}

${description}

## Capabilities

- **[Capability name]**: [Description of what this capability does]

## Related Files

- ${bt}steering/${bt} (optional, hand-authored) — add Kiro steering files here if needed
`;

  return [{ path: 'POWER.md', content }];
}
