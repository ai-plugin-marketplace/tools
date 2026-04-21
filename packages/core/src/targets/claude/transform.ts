/**
 * Mechanical transformations for the Claude Code target.
 *
 * Per §7.1 of the architecture spec, every function here is a pure function driven by
 * committed logic, bounded to the Claude target. No filesystem I/O; no cross-target
 * imports; no tool-name translation (Claude is the source dialect — §7.3).
 *
 * @see docs/specs/architecture.md §7.2, §12.4, §12.5
 */

import { parse as parseYaml } from 'yaml';
import type { ClaudeHooksFile } from './schemas.js';
import { claudeHooksFileSchema } from './schemas.js';

/**
 * Parse YAML hook source and validate against the Claude hooks schema.
 * Pure — takes a string, returns validated data. Throws {@link ZodError} on bad shape.
 *
 * @param yamlContent - Raw YAML string (contents of `hooks/claude.yaml`).
 * @returns Validated {@link ClaudeHooksFile}.
 * @throws {ZodError} If the parsed value does not match the hooks schema.
 * @throws {Error} If the YAML itself is malformed.
 */
export function parseClaudeHooksYaml(yamlContent: string): ClaudeHooksFile {
  const parsed: unknown = parseYaml(yamlContent);
  return claudeHooksFileSchema.parse(parsed);
}

/**
 * Serialize validated hooks data as pretty-printed JSON matching the current
 * `build-hooks.ts` output: 2-space indent, trailing newline.
 *
 * @param data - Validated {@link ClaudeHooksFile}.
 * @returns JSON string with 2-space indentation and a trailing `\n`.
 */
export function serializeClaudeHooksJson(data: ClaudeHooksFile): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Convenience: one-shot YAML string → JSON string conversion with validation.
 * Matches the end-to-end behavior of the current `src/build-hooks.ts`:
 * parse YAML, validate against the hooks schema, serialize as pretty JSON.
 *
 * @param yamlContent - Raw YAML string (contents of `hooks/claude.yaml`).
 * @returns Pretty-printed JSON string with trailing newline.
 * @throws {ZodError} If the parsed value does not match the hooks schema.
 * @throws {Error} If the YAML itself is malformed.
 */
export function convertClaudeHooksYamlToJson(yamlContent: string): string {
  return serializeClaudeHooksJson(parseClaudeHooksYaml(yamlContent));
}
