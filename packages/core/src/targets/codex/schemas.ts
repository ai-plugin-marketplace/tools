/**
 * Zod schemas for the OpenAI Codex CLI target manifests.
 *
 * These schemas are internal to @ai-plugin-marketplace/core — they are not exported from the
 * package root. Per §3.4 of the architecture spec, this module must not import from any sibling
 * targets/<other>/ folder, so the shapes are intentionally duplicated from the Claude target
 * (rather than imported) and may diverge independently in the future.
 *
 * Codex is an in-place marketplace target like Claude/Cursor: its plugin manifest lives at
 * `.codex-plugin/plugin.json` and is consumed in place (no `dist/` bundle, no mechanical
 * transform). The field list mirrors Claude's `.claude-plugin/plugin.json` with two
 * Codex-specific additions documented at developers.openai.com/codex/plugins/build:
 *
 *   - `interface` — an optional loose object describing the plugin's presentation in the Codex
 *     marketplace UI (displayName, category, capabilities, …). Loose because the field set is
 *     UI-driven and free to grow.
 *   - `apps` — an optional relative path string pointing at an apps directory.
 *
 * `skills`/`agents`/`commands`/`hooks` accept exactly what Claude accepts (relative path string,
 * array of relative path strings, or — for hooks/commands — an inline object), plus Codex's
 * tolerance for a plain string wherever Claude already accepts one.
 *
 * @see https://developers.openai.com/codex/plugins/build
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Author object in the plugin manifest. Strict per the canonical JSON Schema
 * (`additionalProperties: false`).
 */
const codexPluginAuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// codexPluginManifestSchema
// ---------------------------------------------------------------------------

/**
 * Schema for `.codex-plugin/plugin.json`.
 *
 * Mirrors Claude's plugin manifest (same `name` pattern, optional `version`/`description`/etc.)
 * with Codex's optional `interface` (loose object) and `apps` (relative path string) fields.
 * Strict (`additionalProperties: false`) at the top level so unknown keys are rejected.
 * `schemaVersion` is accepted but not validated (§9.4 / §12.2).
 */
export const codexPluginManifestSchema = z
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
    author: codexPluginAuthorSchema.optional(),

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
     * with `.json`), or an inline hooks configuration object. Codex hook generation is out of
     * scope for v0.1.0; the field is accepted but not exercised by the scaffolder.
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
     * Must start with `./`. Codex tolerates a single string (e.g. "./skills/") as well as the
     * array form Claude uses.
     */
    skills: z.union([z.string().regex(/^\.\//), z.array(z.string().regex(/^\.\//))]).optional(),

    /**
     * MCP server configuration — relative path string to a `.mcp.json` (Codex consumes the
     * shared Claude/Cursor format) or an inline record of server configs.
     */
    mcpServers: z.union([z.string().regex(/^\.\//), z.record(z.string(), z.unknown())]).optional(),

    /**
     * Apps — relative path string to an apps directory (Codex-specific). Must start with `./`.
     */
    apps: z.string().regex(/^\.\//).optional(),

    /**
     * Marketplace presentation metadata (displayName, category, capabilities, websiteURL,
     * defaultPrompt, brandColor, logo, screenshots, …). Loose: the field set is UI-driven and
     * free to grow, so unknown keys are tolerated rather than rejected.
     */
    interface: z.object({}).loose().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// codexMcpConfigSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single MCP server entry. Strict: only `command`, `args`, and `env` are
 * accepted — matching the shared `.mcp.json` format Codex reuses from Claude/Cursor.
 */
const codexMcpServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Schema for `.mcp.json` (the MCP configuration Codex reads — identical to Claude's format).
 *
 * `mcpServers` maps server name → server config. Strict at the top level.
 * `schemaVersion` accepted but not validated per §9.4 / §12.2.
 */
export const codexMcpConfigSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    mcpServers: z.record(z.string(), codexMcpServerSchema),
  })
  .strict();
