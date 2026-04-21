/**
 * Zod schemas for the Gemini CLI target.
 *
 * These are faithful, non-breaking ports of the JSON Schema contracts that the template
 * repository has used in practice. Per §13 Phase A of the architecture spec, no schema
 * breaking changes are introduced here — this is a mechanical port only.
 *
 * @see https://ai.google.dev/gemini-api/docs/gemini-cli (Gemini CLI extension format)
 * @see docs/specs/architecture.md §3.4, §7.2, §9.4, §12.2, §13 Phase A
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Canonical Gemini CLI tool names
// ---------------------------------------------------------------------------

/**
 * The canonical set of Gemini CLI tool names, derived from the CLAUDE_TO_GEMINI_TOOLS
 * mapping in build-standalone.ts of the template repository.
 *
 * Stage 3's transform layer consumes this for tool-name validation. Exporting from the
 * schema module keeps the data colocated with the authoritative type definitions.
 */
export const GEMINI_TOOL_NAMES = [
  'read_file',
  'replace',
  'search_file_content',
  'glob',
  'run_shell_command',
  'write_file',
  'activate_skill',
] as const;

/** Union type of all valid Gemini CLI tool names. */
export type GeminiToolName = (typeof GEMINI_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// gemini-extension.json
// ---------------------------------------------------------------------------

/**
 * Schema for `gemini-extension.json` — the Gemini CLI extension manifest.
 *
 * NOTE: This schema uses `.loose()` at the top level rather than `.strict()`. Gemini CLI
 * may include additional top-level fields that the template does not yet model (e.g., display
 * metadata, capability declarations). Using `.loose()` tolerates those unknown fields without
 * breaking validation, which matches the original `GeminiExtensionSchema` in validate.ts.
 * When Gemini's manifest format is formally documented and stabilised, tighten this to
 * `.strict()` and enumerate every known field.
 */
export const geminiExtensionManifestSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    description: z.string().optional(),
    schemaVersion: z.string().optional(),
  })
  .loose();

/** Inferred TypeScript type for `gemini-extension.json`. */
export type GeminiExtensionManifest = z.infer<typeof geminiExtensionManifestSchema>;

// ---------------------------------------------------------------------------
// agents/*.md YAML frontmatter (as emitted for Gemini)
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML frontmatter of `agents/*.md` files emitted for the Gemini CLI target.
 *
 * NOTE: This schema uses `.loose()` for the same reason as `geminiExtensionManifestSchema` —
 * agent frontmatter may include additional fields that Gemini CLI accepts but that the template
 * does not yet model. The `tools` field accepts `string[]` without constraining to
 * `GEMINI_TOOL_NAMES` because tool-name validation belongs to Stage 3's transform layer, not
 * the shape-only validator here.
 */
export const geminiAgentFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tools: z.array(z.string()).optional(),
    schemaVersion: z.string().optional(),
  })
  .loose();

/** Inferred TypeScript type for Gemini agent frontmatter. */
export type GeminiAgentFrontmatter = z.infer<typeof geminiAgentFrontmatterSchema>;
