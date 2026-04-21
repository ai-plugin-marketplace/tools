/**
 * Zod schemas for the Vercel Skills CLI target.
 *
 * The primary artifact for the Vercel target is `SKILL.md` — a markdown file with YAML
 * frontmatter consumed by the Vercel Skills CLI per the agentskills.io spec. There is no
 * `plugin.json`-like manifest; `SKILL.md` is the complete surface.
 *
 * This module must not import from any sibling targets/<other>/ folder (§3.4).
 *
 * Note on ownership: `SKILL.md` is also consumed by Claude, Cursor, Gemini, and Kiro
 * (via steering), but the schema lives here because Vercel's primary surface is SKILL.md.
 * A future refactor may move it to a shared module (see §16 open questions).
 *
 * schemaVersion: accepted but not validated in v0.1.0 per §9.4 and §12.2.
 *
 * @see https://agentskills.io (agentskills.io spec — source of name/description constraints)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants (exported so Stage 4 validators can reference without re-deriving)
// ---------------------------------------------------------------------------

/** Maximum byte length for a skill `name` field per agentskills.io spec. */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Maximum byte length for a skill `description` field per agentskills.io spec. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

// ---------------------------------------------------------------------------
// vercelSkillFrontmatterSchema
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML frontmatter of `SKILL.md` files per the agentskills.io spec.
 *
 * Constraints faithfully ported from `validateSkillFrontmatter` in the template repo:
 *   - `name`: lowercase-alphanumeric-with-hyphens slug, max 64 chars, must start with a
 *     letter, no consecutive hyphens (`--`), no trailing hyphen.
 *   - `description`: non-empty string, max 1024 chars.
 *
 * `.loose()` (passthrough) is used at the top level because authors may add
 * platform-specific keys (e.g., Claude's `model`, `tools`, `color`).
 *
 * Parent-directory-name matching is a Stage 4 cross-validator concern — not enforced here.
 * Body line-count (soft 500-line recommendation) is informational — not enforced here.
 */
export const vercelSkillFrontmatterSchema = z
  .object({
    /** Reserved for future migrex adoption. Accepted but not validated in v0.1.0. */
    schemaVersion: z.string().optional(),

    /**
     * Skill identifier. Must be a lowercase alphanumeric slug:
     *   - Starts with `[a-z]`
     *   - Contains only `[a-z0-9-]`
     *   - Maximum 64 characters
     *   - No consecutive hyphens (`--`)
     *   - Does not end with a hyphen
     */
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'name must be lowercase alphanumeric with hyphens, starting with a letter',
      )
      .max(SKILL_NAME_MAX_LENGTH)
      .refine((v) => !v.includes('--'), {
        message: 'name must not contain consecutive hyphens',
      })
      .refine((v) => !v.endsWith('-'), {
        message: 'name must not end with a hyphen',
      }),

    /** What this skill does. Non-empty, maximum 1024 characters. */
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
  })
  .loose();

export type VercelSkillFrontmatter = z.infer<typeof vercelSkillFrontmatterSchema>;
