/**
 * Scaffold templates for the Vercel Skills CLI target.
 *
 * `scaffoldVercelFiles` is a pure function returning the skeleton files this target contributes
 * to a new plugin: a `skills/<name>/SKILL.md` whose YAML frontmatter is the complete Vercel
 * surface (there is no separate plugin.json-like manifest). The frontmatter carries
 * `schemaVersion: "0.1.0"` (§12.2). No generated-file sentinels — this is an author-authored
 * skeleton file (§4.3).
 *
 * This module must not import from any sibling targets/<other>/ folder (§3.4).
 *
 * @see https://agentskills.io (SKILL.md frontmatter constraints)
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

/** Identity tag enabling editor highlighting of the embedded Markdown body. */
const md = String.raw;

/**
 * Produce the Vercel skeleton files for a plugin.
 *
 * The minimum required artifact (validated specially in `validateEnvelopeAdherence`) is at least
 * one `skills/<skill>/SKILL.md`. The scaffold seeds a single skill named after the plugin; the
 * frontmatter satisfies `vercelSkillFrontmatterSchema` (`name` slug + non-empty `description`).
 *
 * The skill directory name MUST equal the frontmatter `name` (Stage 4 cross-validator); both are
 * the plugin name here.
 *
 * @param pluginName - Plugin identity; used as the skill directory name and frontmatter `name`.
 * @param opts - Optional description and add-target placeholder behaviour.
 * @returns Files contributed by this target, with paths relative to the plugin directory.
 */
export function scaffoldVercelFiles(
  pluginName: string,
  opts: TargetScaffoldOptions = {},
): ScaffoldedFile[] {
  const description = resolveDescription(pluginName, opts);

  // `description` is constrained to min length 1. In placeholder mode (add-target) we emit an
  // empty value, intentionally leaving an incomplete-but-fillable skeleton per §6.4; the author
  // completes it before the plugin validates.
  const content = md`---
schemaVersion: ${SCHEMA_VERSION}
name: ${pluginName}
description: ${JSON.stringify(description)}
---

# ${pluginName}

${description}

## Procedure

1. [Step 1]
2. [Step 2]
3. [Step 3]
`;

  return [{ path: `skills/${pluginName}/SKILL.md`, content }];
}
