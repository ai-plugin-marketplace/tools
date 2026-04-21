/**
 * Zod schemas for Cursor target manifests.
 *
 * These schemas are intentionally duplicated from the Claude target — per §3.4 of the
 * architecture spec, no file in this folder may import from a sibling target folder.
 * The duplication allows Cursor and Claude schemas to diverge independently in the future.
 *
 * Schema shapes derived from:
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/schemas/plugin.json
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-object schemas
// ---------------------------------------------------------------------------

const cursorPluginAuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// cursorPluginManifestSchema
//
// Models .cursor-plugin/plugin.json. Identical field list to Claude's manifest
// for v0.1.0 (per the current JSON Schema — see §13 Phase A "no schema breaking
// changes"). Uses .strict() to enforce additionalProperties: false.
// ---------------------------------------------------------------------------

export const cursorPluginManifestSchema = z
  .object({
    /** Lowercase, hyphens, no spaces. Pattern: ^[a-z][a-z0-9-]*$ */
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(64),
    /** Semantic version string, e.g. "0.0.1" */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/)
      .optional(),
    description: z.string().min(1).max(1024).optional(),
    author: cursorPluginAuthorSchema.optional(),
    homepage: z.url().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.string().array().optional(),
    /**
     * Hooks — either a relative .json path (starting with "./", ending ".json")
     * or an inline hooks object.
     */
    hooks: z
      .union([z.string().regex(/^\.\/.+\.json$/), z.record(z.string(), z.unknown())])
      .optional(),
    /**
     * Commands — relative path string, array of relative paths, or record of
     * command objects.
     */
    commands: z
      .union([
        z.string().regex(/^\.\//),
        z.string().regex(/^\.\//).array(),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
    /**
     * Agents — relative .md path or array of relative .md paths.
     */
    agents: z
      .union([
        z.string().regex(/^\.\/.+\.md$/),
        z
          .string()
          .regex(/^\.\/.+\.md$/)
          .array(),
      ])
      .optional(),
    /**
     * Skills — relative directory path or array of relative directory paths.
     * Not SKILL.md file paths — directory paths only.
     */
    skills: z.union([z.string().regex(/^\.\//), z.string().regex(/^\.\//).array()]).optional(),
    outputStyles: z.record(z.string(), z.unknown()).optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    lspServers: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    /**
     * Reserved for future migration graph. Validators do not check this in
     * v0.1.0 — §9.4. Scaffolds emit "0.1.0".
     */
    schemaVersion: z.string().optional(),
  })
  .strict();

export type CursorPluginManifest = z.infer<typeof cursorPluginManifestSchema>;

// ---------------------------------------------------------------------------
// cursorMcpConfigSchema
//
// Models .mcp.json as used by Cursor (today identical to Claude's format).
// ---------------------------------------------------------------------------

const cursorMcpServerSchema = z
  .object({
    command: z.string(),
    args: z.string().array().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const cursorMcpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), cursorMcpServerSchema),
    schemaVersion: z.string().optional(),
  })
  .strict();

export type CursorMcpConfig = z.infer<typeof cursorMcpConfigSchema>;

// ---------------------------------------------------------------------------
// cursorRuleFrontmatterSchema
//
// Models the YAML frontmatter found in Cursor .mdc rule files (e.g.
// plugins/skill-evaluator/rules/evaluation-protocol.mdc). The observed fields
// are: description, alwaysApply (boolean), globs (string[]). Additional fields
// are not strict because .mdc frontmatter is extensible by Cursor tooling.
// ---------------------------------------------------------------------------

export const cursorRuleFrontmatterSchema = z.object({
  description: z.string().optional(),
  alwaysApply: z.boolean().optional(),
  globs: z.string().array().optional(),
  schemaVersion: z.string().optional(),
});

export type CursorRuleFrontmatter = z.infer<typeof cursorRuleFrontmatterSchema>;
