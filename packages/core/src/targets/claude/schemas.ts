/**
 * Zod schemas for Claude Code target manifests.
 *
 * These schemas are internal to @ai-plugin-marketplace/core — they are not exported from the
 * package root. Per §3.4 of the architecture spec, this module must not import from any sibling
 * targets/<other>/ folder.
 *
 * Strictness policy: `.strict()` is used wherever the canonical JSON Schema sets
 * `additionalProperties: false`. `.loose()` (passthrough) is reserved for agent frontmatter,
 * which is free-form markdown context where authors may add platform-specific keys.
 *
 * schemaVersion: every top-level manifest schema accepts `schemaVersion` as an optional
 * unvalidated string per §9.4 and §12.2. Validators do not check it in v0.1.0; it is reserved
 * for future migrex adoption.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Author object in the plugin manifest. Strict per JSON Schema
 * (`additionalProperties: false`).
 */
const claudePluginAuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// claudePluginManifestSchema
// ---------------------------------------------------------------------------

/**
 * Schema for `.claude-plugin/plugin.json`.
 *
 * Mirrors the canonical JSON Schema at
 * `schemas/plugin.json` in the template repo. Strict (`additionalProperties: false`).
 * `schemaVersion` is accepted but not validated (§9.4 / §12.2).
 */
export const claudePluginManifestSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Plugin name: lowercase, hyphens, no spaces; must start with a letter. Max 64 chars. */
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'name must be lowercase alphanumeric with hyphens, starting with a letter',
      )
      .max(64),

    /** Semantic version string (optional). */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/, 'version must be a valid semver string')
      .optional(),

    /** What this plugin does. */
    description: z.string().min(1).max(1024).optional(),

    /** Plugin author information. */
    author: claudePluginAuthorSchema.optional(),

    /** Plugin homepage URL. */
    homepage: z.string().optional(),

    /** Source repository URL or shorthand. */
    repository: z.string().optional(),

    /** SPDX license identifier. */
    license: z.string().optional(),

    /** Discovery keywords. */
    keywords: z.array(z.string()).optional(),

    /**
     * Hooks configuration — relative path to a `.json` file (must start with `./` and end
     * with `.json`), or an inline hooks configuration object.
     */
    hooks: z
      .union([z.string().regex(/^\.\/.*\.json$/), z.record(z.string(), z.unknown())])
      .optional(),

    /**
     * Commands — relative path starting with `./`, an array of such paths, or a record of
     * command name → command object.
     */
    commands: z
      .union([
        z.string().regex(/^\.\//),
        z.array(z.string().regex(/^\.\//)),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),

    /**
     * Agent definitions — relative `.md` path or array of such paths.
     * Must start with `./` and end with `.md`.
     */
    agents: z
      .union([z.string().regex(/^\.\/.+\.md$/), z.array(z.string().regex(/^\.\/.+\.md$/))])
      .optional(),

    /**
     * Skill definitions — relative path to a skill directory or array of such paths.
     * Must start with `./`.
     */
    skills: z.union([z.string().regex(/^\.\//), z.array(z.string().regex(/^\.\//))]).optional(),

    /** Output style configuration. */
    outputStyles: z.record(z.string(), z.unknown()).optional(),

    /** MCP server configuration. */
    mcpServers: z.record(z.string(), z.unknown()).optional(),

    /** LSP server configuration. */
    lspServers: z.record(z.string(), z.unknown()).optional(),

    /** Plugin settings configuration. */
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// claudeMcpConfigSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single MCP server entry. Strict: only `command`, `args`, and `env` are
 * accepted — matching the Claude `.mcp.json` format.
 */
const claudeMcpServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Schema for `.mcp.json` (Claude MCP configuration).
 *
 * `mcpServers` maps server name → server config. Strict at the top level.
 * `schemaVersion` accepted but not validated per §9.4 / §12.2.
 */
export const claudeMcpConfigSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    mcpServers: z.record(z.string(), claudeMcpServerSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// claudeHooksFileSchema
// ---------------------------------------------------------------------------

/**
 * Known Claude Code hook event types. Unknown events are rejected at the schema level.
 */
const claudeHookEventSchema = z.enum(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']);

/**
 * A single hook entry: a command to run.
 */
export const claudeHookEntrySchema = z
  .object({
    type: z.literal('command'),
    command: z.string(),
  })
  .strict();

/**
 * A hook matcher: optional regex filter + description + list of hook entries to run.
 */
export const claudeHookMatcherSchema = z
  .object({
    matcher: z.string().optional(),
    description: z.string().optional(),
    hooks: z.array(claudeHookEntrySchema),
  })
  .strict();

/**
 * Schema for `hooks/claude.json`.
 *
 * Top level: `{ hooks: Record<ClaudeHookEvent, ClaudeHookMatcher[]> }`. Strict.
 * `schemaVersion` accepted but not validated per §9.4 / §12.2.
 */
export const claudeHooksFileSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    hooks: z.partialRecord(claudeHookEventSchema, z.array(claudeHookMatcherSchema)),
  })
  .strict();

export type ClaudeHooksFile = z.infer<typeof claudeHooksFileSchema>;

// ---------------------------------------------------------------------------
// claudeAgentFrontmatterSchema
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML frontmatter of `agents/*.md` files.
 *
 * Permissive (`.loose()` / passthrough) because frontmatter is free-form markdown context
 * where authors may add platform-specific keys. The transform layer (Stage 3) handles
 * tool-name lookup and its errors — `tools` here is an unvalidated string array.
 *
 * `schemaVersion` accepted but not validated per §9.4 / §12.2.
 */
export const claudeAgentFrontmatterSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Agent display name. Required. */
    name: z.string(),

    /** What this agent does. Required. */
    description: z.string(),

    /**
     * Tools the agent may use. Unvalidated strings — the Claude tool enum is enforced in
     * Stage 3's transform layer, not here.
     */
    tools: z.array(z.string()).optional(),

    /** Model hint (e.g. 'opus', 'sonnet', 'haiku'). Not validated against an enum. */
    model: z.string().optional(),

    /** Display color hint. */
    color: z.string().optional(),
  })
  .loose();
