/**
 * Per-target validators for the Vercel Skills CLI target.
 *
 * The Vercel target's primary authored artifact is `SKILL.md` — one file per
 * skill directory under `plugins/<name>/skills/<skill-name>/SKILL.md`. This
 * module validates:
 *   1. YAML frontmatter presence and schema conformance.
 *   2. Name/parent-directory consistency (the agentskills.io spec requires that
 *      a skill's frontmatter `name` matches the name of its immediate parent
 *      directory).
 *   3. Body line-count recommendation (soft finding when body exceeds 500 lines).
 *
 * Cross-target concerns (envelope-adherence, name-consistency, mcp-key-sync,
 * marketplace-registration, freshness) are out of scope for this module.
 *
 * @see docs/specs/architecture.md §10 (validation contract), §8.1 (Finding types)
 * @see https://agentskills.io (agentskills.io spec — source of name/description constraints)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Finding } from '../../pipeline/types.js';
import { vercelSkillFrontmatterSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Soft-finding threshold for SKILL.md body length per agentskills.io recommendation. */
const BODY_LINE_SOFT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hardFinding(pluginName: string, message: string, hint?: string): Finding {
  const finding: Finding = {
    severity: 'hard',
    code: 'schema-invalid',
    plugin: pluginName,
    message,
  };
  if (hint !== undefined) {
    finding.hint = hint;
  }
  return finding;
}

function softFinding(
  pluginName: string,
  code: Finding['code'],
  message: string,
  hint?: string,
): Finding {
  const finding: Finding = {
    severity: 'soft',
    code,
    plugin: pluginName,
    message,
  };
  if (hint !== undefined) {
    finding.hint = hint;
  }
  return finding;
}

// ---------------------------------------------------------------------------
// SKILL.md discovery — one level deep under `plugins/<name>/skills/`
// ---------------------------------------------------------------------------

/**
 * Return absolute paths to every `SKILL.md` found exactly one directory deep
 * under `skillsDir`. Does not recurse further (current template convention).
 */
function findSkillMds(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];

  const results: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(skillsDir, entry.name, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      results.push(candidate);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Per-file SKILL.md validation
// ---------------------------------------------------------------------------

/**
 * Validate a single `SKILL.md` file against the agentskills.io spec.
 *
 * Checks performed:
 *  - Frontmatter block present (`---\n...\n---`).
 *  - Frontmatter parses as YAML.
 *  - Parsed frontmatter satisfies `vercelSkillFrontmatterSchema`.
 *  - `name` in frontmatter equals the immediate parent directory name.
 *  - Body line count does not exceed the soft limit of 500 lines.
 */
function validateSkillMd(skillPath: string, pluginName: string): Finding[] {
  const content = fs.readFileSync(skillPath, 'utf-8');
  // Relative path from the plugin root is included in messages so the author
  // can quickly locate the file (e.g. `skills/evaluate-skill/SKILL.md`).
  const relPath = path.relative(path.join(path.dirname(skillPath), '..', '..'), skillPath);

  // Derive the expected skill name from the parent directory.
  const parentDir = path.basename(path.dirname(skillPath));

  // ------------------------------------------------------------------
  // 1. Frontmatter block
  // ------------------------------------------------------------------
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (fmMatch === null) {
    return [
      hardFinding(
        pluginName,
        `${relPath}: SKILL.md has no frontmatter block`,
        `add a YAML frontmatter block between --- markers at the top of ${relPath}`,
      ),
    ];
  }

  // ------------------------------------------------------------------
  // 2. YAML parse
  // ------------------------------------------------------------------
  const frontmatterYaml = fmMatch[1] ?? '';
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      hardFinding(
        pluginName,
        `${relPath}: frontmatter YAML parse error: ${msg}`,
        `fix the YAML syntax in the frontmatter of ${relPath}`,
      ),
    ];
  }

  // ------------------------------------------------------------------
  // 3. Schema validation
  // ------------------------------------------------------------------
  const schemaResult = vercelSkillFrontmatterSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      hardFinding(
        pluginName,
        `${relPath}: frontmatter does not match schema — ${issues}`,
        `ensure ${relPath} frontmatter includes required fields (name, description) and meets agentskills.io constraints`,
      ),
    ];
  }

  const frontmatter = schemaResult.data;
  const findings: Finding[] = [];

  // ------------------------------------------------------------------
  // 4. Name/parent-directory consistency (hard)
  //    Per agentskills.io: frontmatter `name` must equal the parent dir name.
  // ------------------------------------------------------------------
  if (frontmatter.name !== parentDir) {
    findings.push({
      severity: 'hard',
      code: 'name-consistency',
      plugin: pluginName,
      message: `${relPath}: frontmatter name "${frontmatter.name}" does not match parent directory "${parentDir}"`,
      hint: `rename the skill directory to "${frontmatter.name}" or update the name field to "${parentDir}"`,
    });
  }

  // ------------------------------------------------------------------
  // 5. Body line-count recommendation (soft)
  //    The body is everything after the closing `---` of the frontmatter block.
  // ------------------------------------------------------------------
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd !== -1) {
    const body = content.slice(fmEnd + 3).trimStart();
    const bodyLines = body === '' ? 0 : body.split('\n').length;
    if (bodyLines > BODY_LINE_SOFT_LIMIT) {
      findings.push(
        softFinding(
          pluginName,
          'schema-invalid',
          `${relPath}: body is ${bodyLines.toString()} lines (recommended max ${BODY_LINE_SOFT_LIMIT.toString()})`,
          `consider splitting the skill into smaller, focused skills`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run Vercel-specific validators (SKILL.md shape and name consistency)
 * against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * All findings use `plugin: path.basename(pluginDir)`.
 */
export function validateVercelPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);
  const skillsDir = path.join(pluginDir, 'skills');
  const skillPaths = findSkillMds(skillsDir);

  const findings: Finding[] = [];
  for (const skillPath of skillPaths) {
    findings.push(...validateSkillMd(skillPath, pluginName));
  }
  return findings;
}
