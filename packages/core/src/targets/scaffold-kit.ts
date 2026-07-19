/**
 * Shared scaffold primitives for per-target scaffold modules.
 *
 * This module lives at `targets/` (not inside any single target folder), so importing it from a
 * `targets/<target>/scaffold.ts` file does NOT violate the cross-target-import rule (§3.4) — that
 * rule forbids importing from a *sibling target* folder, not from shared infrastructure.
 *
 * It carries no target-specific logic: only the common file-descriptor shape, the canonical
 * `schemaVersion` literal (§12.2), and the per-target scaffold option bag.
 *
 * @see docs/specs/architecture.md §12.2 (schemaVersion on every manifest)
 * @see docs/specs/architecture.md §12.5 (per-target scaffold.ts)
 */

/**
 * Canonical `schemaVersion` literal emitted by every scaffolded manifest in this toolkit version.
 * Pinned per §9.4 / §12.2 — a single value in v0.1.0.
 */
export const SCHEMA_VERSION = '0.1.0';

/**
 * Canonical starter `version` for a freshly-scaffolded plugin — a conventional "not yet released"
 * semver, distinct from {@link SCHEMA_VERSION} (which is a manifest *schema* version, not the
 * plugin's own release version). Both `aipm.config.ts`'s `version` and every scaffolded target
 * manifest's `version` field must emit this same literal so a freshly-scaffolded plugin passes
 * `version-consistency` out of the box.
 */
export const INITIAL_PLUGIN_VERSION = '0.0.1';

/**
 * A single file a target contributes to a scaffolded plugin.
 *
 * `path` is RELATIVE to the plugin directory (e.g. `.claude-plugin/plugin.json`). Content is the
 * complete file body. Scaffold functions are pure — they never touch the filesystem.
 */
export interface ScaffoldedFile {
  /** Path relative to the plugin directory. POSIX-style forward slashes. */
  path: string;
  /** Complete file content. */
  content: string;
}

/**
 * Options accepted by a per-target scaffold function.
 *
 * When `placeholder` is true (the `aipm add-target` path, §6.4), descriptive fields are emitted
 * as empty/placeholder values for the author to fill in rather than auto-generated text.
 */
export interface TargetScaffoldOptions {
  /** Human-readable plugin description. Omitted → a deterministic default per target. */
  description?: string;
  /**
   * Emit blank manifest fields for the author to complete, per §6.4 "leaving manifest fields
   * blank for the author". Used by `aipm add-target`. Default: false.
   */
  placeholder?: boolean;
}

/**
 * Resolve the description to embed in a scaffolded manifest whose schema treats `description` as
 * optional (or unconstrained when present).
 *
 * - `placeholder` mode → empty string (author fills it in). Callers whose manifest key is
 *   itself optional typically omit the key entirely when this returns `''`, so the skeleton
 *   stays schema-valid; callers whose key is required but unconstrained (e.g. `z.string()` with
 *   no `.min()`) may emit the empty string directly.
 * - explicit `description` → used verbatim.
 * - otherwise → a deterministic default derived from the plugin name.
 *
 * Deterministic: never reads the clock or environment (scaffold output must be reproducible).
 *
 * For a manifest whose `description` is REQUIRED and constrained to be non-empty (e.g. Vercel's
 * `SKILL.md` frontmatter, `z.string().min(1)`), use {@link resolveRequiredDescription} instead —
 * an empty string there is schema-invalid, not merely incomplete (issue #90).
 */
export function resolveDescription(pluginName: string, opts: TargetScaffoldOptions): string {
  if (opts.placeholder) return '';
  return opts.description ?? `A plugin for ${pluginName}`;
}

/**
 * Placeholder prose emitted by {@link resolveRequiredDescription} in placeholder mode — non-empty
 * so it satisfies `z.string().min(1)`-style schema constraints while still clearly signaling to
 * the author that it must be replaced.
 */
const REQUIRED_DESCRIPTION_PLACEHOLDER = 'TODO: describe this plugin.';

/**
 * Resolve the description to embed in a scaffolded manifest whose schema REQUIRES a non-empty
 * `description` (e.g. Vercel's `SKILL.md` frontmatter, `description: z.string().min(1)`).
 *
 * Unlike {@link resolveDescription}, `placeholder` mode here returns
 * {@link REQUIRED_DESCRIPTION_PLACEHOLDER} rather than `''`: the field can't be omitted (it's
 * required) and an empty string would fail the schema outright, producing a skeleton that
 * `aipm build`/`aipm validate` immediately rejects as `schema-invalid` (issue #90). The author
 * still must replace the placeholder text, same as any other placeholder field.
 */
export function resolveRequiredDescription(
  pluginName: string,
  opts: TargetScaffoldOptions,
): string {
  if (opts.placeholder) return REQUIRED_DESCRIPTION_PLACEHOLDER;
  return opts.description ?? `A plugin for ${pluginName}`;
}
