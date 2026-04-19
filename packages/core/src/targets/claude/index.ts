/**
 * Internal module barrel for the Claude Code target.
 *
 * Contents arrive in Stages 2–4 of the bootstrap plan:
 *   - schemas.ts   Zod schemas for .claude-plugin/plugin.json, .mcp.json, hooks/claude.json
 *   - transform.ts YAML→JSON hook conversion and tool-name preservation
 *   - validate.ts  Per-target validators (hooks event taxonomy, agent frontmatter, etc.)
 *   - scaffold.ts  Scaffold templates for `aipm scaffold` and `aipm add-target`
 *
 * This file — along with the folder — is internal to @ai-plugin-marketplace/core and is not
 * exported from the package root. Per §3.4 of the spec, no file under this directory may
 * import from a sibling targets/<other>/ folder.
 */

export {};
