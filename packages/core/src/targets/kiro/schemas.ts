/**
 * Zod schemas for the Kiro target.
 *
 * These are faithful, non-breaking ports of the JSON Schema contracts that the template
 * repository has used in practice. Per §13 Phase A of the architecture spec, no schema
 * breaking changes are introduced here — this is a mechanical port only.
 *
 * Strictness policy:
 *   - `.loose()` is used on `kiroPowerMdFrontmatterSchema` because POWER.md frontmatter is
 *     free-form markdown context where authors may add platform-specific keys.
 *   - `.strict()` is used on `kiroAgentConfigSchema` because it is a generated file — unknown
 *     fields indicate a bug in the generator.
 *   - `kiroMcpConfigSchema` is strict at the top level; server entries are strict.
 *
 * schemaVersion: every top-level manifest schema accepts `schemaVersion` as an optional
 * unvalidated string per §9.4 and §12.2. Validators do not check it in v0.1.0; it is reserved
 * for future migrex adoption.
 *
 * @see docs/specs/architecture.md §3.4, §7.2, §9.4, §12.2, §13 Phase A
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Canonical Kiro tool names
// ---------------------------------------------------------------------------

/**
 * The canonical set of Kiro CLI tool names, derived from the CLAUDE_TO_KIRO_TOOLS mapping
 * in build-standalone.ts of the template repository.
 *
 * Stage 3's transform layer consumes this for tool-name validation. Exporting from the
 * schema module keeps the data colocated with the authoritative type definitions.
 */
export const KIRO_TOOL_NAMES = ['read', 'write', 'grep', 'glob', 'shell', 'delegate'] as const;

/** Union type of all valid Kiro CLI tool names. */
export type KiroToolName = (typeof KIRO_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// kiroPowerMdFrontmatterSchema
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML frontmatter of `POWER.md` — Kiro's plugin-level context file.
 *
 * Required fields are `name`, `description`, and `version`, mirroring the checks in
 * `validatePowerMdFrontmatter` in validate.ts of the template repository.
 *
 * NOTE: `.loose()` is intentional here — frontmatter is free-form Markdown context and
 * authors may add platform-specific keys (e.g. `tags`, `homepage`). The schema validates
 * the required minimum; unknown keys pass through.
 */
export const kiroPowerMdFrontmatterSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Plugin name — must match the directory name. */
    name: z.string(),

    /** What this plugin does. */
    description: z.string(),

    /** Semantic version string. */
    version: z.string(),
  })
  .loose();

export type KiroPowerMdFrontmatter = z.infer<typeof kiroPowerMdFrontmatterSchema>;

// ---------------------------------------------------------------------------
// kiroMcpConfigSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single Kiro MCP server entry.
 *
 * Same shape as the Claude `.mcp.json` server entry but modelled independently per the spec —
 * Kiro's `mcp.json` is a separate file from Claude's `.mcp.json`.
 */
export const kiroMcpServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type KiroMcpServer = z.infer<typeof kiroMcpServerSchema>;

/**
 * Schema for Kiro's `mcp.json`.
 *
 * Top-level `{ mcpServers: Record<string, KiroMcpServer> }`. Strict at the top level.
 * `schemaVersion` accepted but not validated per §9.4 / §12.2.
 */
export const kiroMcpConfigSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    mcpServers: z.record(z.string(), kiroMcpServerSchema),
  })
  .strict();

export type KiroMcpConfig = z.infer<typeof kiroMcpConfigSchema>;

// ---------------------------------------------------------------------------
// kiroAgentConfigSchema
// ---------------------------------------------------------------------------

/**
 * Schema for `.kiro/agents/<name>.json` — the Kiro agent configuration file produced by
 * `buildKiroAgentJson` in build-standalone.ts of the template repository.
 *
 * NOTE: `.strict()` is intentional — this is a generated file and unexpected fields indicate
 * a bug in the generator. Tool-name validation (`tools`, `allowedTools`) is intentionally
 * deferred to Stage 3's transform layer; the schema accepts any `string[]` here.
 *
 * Field sources (from buildKiroAgentJson):
 *   name            — string from frontmatter or filename
 *   description     — string from frontmatter or ""
 *   prompt          — trimmed body content
 *   mcpServers      — always {} at generation time
 *   tools           — translated Kiro tool names (string[])
 *   toolAliases     — always {}
 *   allowedTools    — always []
 *   resources       — always []
 *   hooks           — always {}
 *   toolsSettings   — always {}
 *   includeMcpJson  — always true
 *   model           — null or string from frontmatter
 */
export const kiroAgentConfigSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Agent display name. */
    name: z.string(),

    /** What this agent does. */
    description: z.string(),

    /** The agent's system prompt (from the .md body). */
    prompt: z.string(),

    /** MCP server configuration. Opaque at this layer. */
    mcpServers: z.record(z.string(), z.unknown()),

    /**
     * Kiro tool names the agent may use. Accepted as unvalidated strings — the Kiro tool
     * enum is enforced in Stage 3's transform layer, not here.
     */
    tools: z.array(z.string()),

    /** Tool aliases. Opaque at this layer. */
    toolAliases: z.record(z.string(), z.unknown()),

    /**
     * Allowed tools list. Unvalidated strings per the same rationale as `tools`.
     */
    allowedTools: z.array(z.string()),

    /** Resource references. Opaque at this layer. */
    resources: z.array(z.unknown()),

    /** Hook configuration. Opaque at this layer. */
    hooks: z.record(z.string(), z.unknown()),

    /** Per-tool settings. Opaque at this layer. */
    toolsSettings: z.record(z.string(), z.unknown()),

    /** Whether to include the adjacent mcp.json file. */
    includeMcpJson: z.boolean(),

    /** Model hint, or null if not specified. */
    model: z.string().nullable(),
  })
  .strict();

export type KiroAgentConfig = z.infer<typeof kiroAgentConfigSchema>;
