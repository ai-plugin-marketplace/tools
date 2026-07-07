/**
 * Zod schemas for the Open Plugins target manifests.
 *
 * These schemas are internal to @ai-plugin-marketplace/core — they are not exported from the
 * package root. Per §3.4 of the architecture spec, this module must not import from any sibling
 * targets/<other>/ folder, so the shapes are intentionally duplicated from the other in-place
 * targets (rather than imported) and may diverge independently in the future.
 *
 * Open Plugins is a vendor-neutral, in-place marketplace target like Claude/Cursor/Codex: its
 * plugin manifest lives at `.plugin/plugin.json` and is consumed in place (no `dist/` bundle, no
 * mechanical transform). Unlike the native targets, Open Plugins is an EXTERNAL standard, so these
 * schemas encode its published prose specification directly.
 *
 * Two grammars are in play (spec §4.2): the toolkit's scaffold slug (`^[a-z][a-z0-9-]*$`, a strict
 * subset) and the Open Plugins `name` grammar encoded here (1–64 chars, lowercase alphanumeric
 * plus `-`/`.`, alphanumeric start AND end, no `--`, no `..`). The schema accepts the FULL spec
 * grammar so a hand-authored manifest using a digit-start or interior-period name still validates
 * (spec OP-D7); it does not narrow to the scaffold slug.
 *
 * No official JSON Schema is published for Open Plugins v1.0.0 and the referenced `plugin-ref`
 * validator is not on npm (verified 2026-07-07). This Zod schema is therefore the sole authority;
 * it is written directly from the prose spec and pinned at Open Plugins v1.0.0.
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see https://open-plugins.com/plugin-builders/marketplace.md
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Open Plugins `name` grammar (spec §2.1): 1–64 chars, lowercase alphanumeric plus `-` and `.`,
 * alphanumeric start AND end, no consecutive `--`, no consecutive `..`. The char-class/anchor
 * regex equals Cursor's installed runtime regex `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` (empirical
 * §5.2), and the two `refine`s add the spec's "no `--` / no `..`" MUSTs. A single character is
 * legal (the optional inner+trailing group).
 */
const openPluginsNameSchema = z
  .string()
  .min(1, 'name must be at least 1 character')
  .max(64, 'name must be at most 64 characters')
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
    'name must be lowercase alphanumeric with hyphens/periods, starting and ending alphanumeric',
  )
  .refine((v) => !v.includes('--'), 'name must not contain consecutive hyphens ("--")')
  .refine((v) => !v.includes('..'), 'name must not contain consecutive periods ("..")');

/**
 * A single component/source path (spec §2.1): MUST be `./`-relative with no parent traversal.
 * Backslashes are rejected outright — manifest paths are POSIX-separated, and allowing `\` would
 * let a Windows-style `..\` segment slip past a `/`-only split (e.g. `./a\..\b`). The refine
 * rejects any path that contains a backslash, does not start with `./`, or contains a `..` segment.
 */
const relativePathSchema = z
  .string()
  .refine(
    (p) => !p.includes('\\') && p.startsWith('./') && !p.split('/').includes('..'),
    'path must be "./"-relative, POSIX-separated (no "\\"), with no ".." parent-traversal segments',
  );

/**
 * A component-path field (`commands` / `agents` / `skills` / `rules` / `hooks` / `mcpServers` /
 * `lspServers` / `outputStyles`), spec §2.1: `string | string[] | { paths, exclusive? }`. Every
 * embedded path is `./`-relative with no `..`. The object form is strict so unknown keys are
 * rejected.
 */
const componentPathFieldSchema = z.union([
  relativePathSchema,
  z.array(relativePathSchema),
  z
    .object({
      paths: z.array(relativePathSchema),
      exclusive: z.boolean().optional(),
    })
    .strict(),
]);

/**
 * Author/owner object (spec §2.1, §2.4): `{ name, email?, url? }`. Strict so unknown keys are
 * rejected, matching the native targets' author schemas.
 */
const openPluginsAuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// openPluginsManifestSchema — `.plugin/plugin.json`
// ---------------------------------------------------------------------------

/**
 * Schema for `.plugin/plugin.json` (spec §2.1).
 *
 * The only REQUIRED field is `name` (Open Plugins grammar). All other fields are optional. The
 * component-path fields accept `string | string[] | { paths, exclusive? }` and constrain every
 * path to `./`-relative, no-`..`. Strict (`additionalProperties: false`) at the top level so
 * unknown keys are rejected. `schemaVersion` is accepted but not validated (§9.4 / §12.2),
 * consistent with every other target manifest.
 */
export const openPluginsManifestSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Plugin name — Open Plugins grammar (spec §2.1). The one required field. */
    name: openPluginsNameSchema,

    /** Semantic version string (optional). */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/, 'version must be a valid semver string')
      .optional(),

    /** What this plugin does. */
    description: z.string().optional(),

    /** Plugin author information. */
    author: openPluginsAuthorSchema.optional(),

    /** Plugin homepage URL. */
    homepage: z.string().optional(),

    /** Source repository URL or shorthand. */
    repository: z.string().optional(),

    /** SPDX license identifier. */
    license: z.string().optional(),

    /** Discovery keywords. */
    keywords: z.array(z.string()).optional(),

    /** Path to a logo asset. */
    logo: z.string().optional(),

    /** Command component paths. */
    commands: componentPathFieldSchema.optional(),

    /** Agent component paths. */
    agents: componentPathFieldSchema.optional(),

    /** Skill component paths. */
    skills: componentPathFieldSchema.optional(),

    /** Rule component paths. */
    rules: componentPathFieldSchema.optional(),

    /** Hook component paths. */
    hooks: componentPathFieldSchema.optional(),

    /** MCP server component paths. */
    mcpServers: componentPathFieldSchema.optional(),

    /** LSP server component paths. */
    lspServers: componentPathFieldSchema.optional(),

    /** Output-style component paths. */
    outputStyles: componentPathFieldSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// openPluginsMarketplaceSchema — `marketplace.json`
// ---------------------------------------------------------------------------

/**
 * A single plugin entry in an Open Plugins `marketplace.json` (spec §2.4): required `name` and a
 * `./`-relative `source` pointing at the plugin directory, plus optional metadata overrides. Strict
 * so unknown keys are rejected.
 */
const openPluginsMarketplaceEntrySchema = z
  .object({
    name: openPluginsNameSchema,
    source: relativePathSchema,
    description: z.string().optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/, 'version must be a valid semver string')
      .optional(),
    author: openPluginsAuthorSchema.optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Schema for a repo-root `marketplace.json` (spec §2.4).
 *
 * Required: `name` and `plugins[]` with at least one entry. Optional: top-level `owner`
 * `{ name, email?, url? }` and `metadata.pluginRoot` (default `"."`, so omission is legal). Strict
 * at the top level. This is the toolkit's authoring authority for the Open Plugins registry; the
 * generated registry (`buildOpenPluginsRegistry`) emits a subset of this shape.
 */
export const openPluginsMarketplaceSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /** Marketplace name — the registry's top-level identity (spec §2.4). Required. */
    name: z.string().min(1, 'marketplace name must not be empty'),

    /** Optional marketplace owner. */
    owner: openPluginsAuthorSchema.optional(),

    /** Optional metadata; `pluginRoot` defaults to `"."` when omitted. */
    metadata: z
      .object({
        pluginRoot: z.string().optional(),
      })
      .strict()
      .optional(),

    /** Plugin entries — at least one required (spec §2.4). */
    plugins: z
      .array(openPluginsMarketplaceEntrySchema)
      .min(1, 'plugins[] must have at least one entry'),
  })
  .strict();
