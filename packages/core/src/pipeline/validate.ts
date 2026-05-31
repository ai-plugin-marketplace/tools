/**
 * Cross-target validator for the pipeline layer.
 *
 * Implements §10.1 steps 1, 3, 4, and most of 5 (freshness deferred to Stage 5).
 * Step 2 (per-target schema validation) lives in each target's own validate.ts and is
 * not invoked here — this module is concerned only with cross-target consistency.
 *
 * @see docs/specs/architecture.md §6, §8.1, §10.1, §10.2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { defineConfig } from '../config.js';
import type { AipmConfigInput } from '../config.js';
import { validateClaudePlugin } from '../targets/claude/validate.js';
import { validateCursorPlugin } from '../targets/cursor/validate.js';
import { validateGeminiPlugin } from '../targets/gemini/validate.js';
import { validateKiroPlugin } from '../targets/kiro/validate.js';
import { validateVercelPlugin } from '../targets/vercel/validate.js';
import {
  collectFilesRelative,
  computeDistBundles,
  computePluginHookArtifacts,
  regenerateBundleToTemp,
} from './build.js';
import { discoverPlugins } from './discover.js';
import { ConfigLoadError, loadPluginConfig } from './load-config.js';
import type { Finding, TargetId, ValidateOptions, ValidationResult } from './types.js';

// ---------------------------------------------------------------------------
// Module-level artifact mappings
// ---------------------------------------------------------------------------

/**
 * Files (relative to pluginDir) that are exclusively owned by a target. If any of these
 * exist on disk for a target NOT in the envelope, that is an adherence violation.
 * Directories are listed without trailing slash; `existsSync` works for either.
 */
const TARGET_OWNED_ARTIFACTS: Record<TargetId, string[]> = {
  claude: [
    '.claude-plugin/plugin.json',
    '.claude-plugin',
    'hooks/claude.yaml',
    'hooks/claude.json',
  ],
  cursor: ['.cursor-plugin/plugin.json', '.cursor-plugin'],
  gemini: ['gemini-extension.json', 'GEMINI.md'],
  kiro: ['POWER.md', 'mcp.json'],
  vercel: [],
};

/**
 * Shared artifacts that require at least one of the listed targets in the envelope.
 * `.mcp.json` is the Claude/Cursor MCP config format, shared between those two targets.
 */
const SHARED_ARTIFACTS: { file: string; anyOf: TargetId[] }[] = [
  { file: '.mcp.json', anyOf: ['claude', 'cursor'] },
];

/**
 * Minimum required artifacts for each target. Missing any of these when the target is
 * in the envelope is an adherence violation.
 * Vercel requires at least one skills/<name>/SKILL.md — handled specially below.
 */
export const TARGET_MIN_REQUIRED: Record<TargetId, string[]> = {
  claude: ['.claude-plugin/plugin.json'],
  cursor: ['.cursor-plugin/plugin.json'],
  gemini: ['gemini-extension.json'],
  kiro: ['POWER.md'],
  vercel: [],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimal Zod schema for marketplace.json. Loose to tolerate extra metadata fields. */
const marketplaceSchema = z
  .object({
    plugins: z.array(
      z
        .object({
          name: z.string(),
          source: z.string(),
        })
        .loose(),
    ),
  })
  .loose();

/** Minimal schema for MCP config files (.mcp.json / mcp.json). */
const mcpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** Read and JSON-parse a file, returning undefined on any error. */
function tryReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Parse YAML frontmatter from a file whose content starts with "---".
 * Returns the frontmatter object (as unknown) or undefined on parse failure.
 */
function tryParseFrontmatter(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = /^---\s*\n([\s\S]*?)\n---/m.exec(content);
    if (!match) return undefined;
    return parseYaml(match[1] ?? '') as unknown;
  } catch {
    return undefined;
  }
}

/** Build a hard Finding. */
function hard(code: Finding['code'], plugin: string, message: string, hint?: string): Finding {
  return { severity: 'hard', code, plugin, message, ...(hint !== undefined ? { hint } : {}) };
}

// ---------------------------------------------------------------------------
// validateEnvelopeShape
// ---------------------------------------------------------------------------

/**
 * Validate an already-loaded `aipm.config.ts` value against AipmConfig's Zod schema.
 * Loading from disk is the pipeline orchestrator's job (Stage 5). Here we only validate shape.
 * Emits `envelope-invalid` findings on malformed input.
 *
 * `pluginName` is used to populate Finding.plugin.
 */
export function validateEnvelopeShape(rawConfig: unknown, pluginName: string): Finding[] {
  try {
    // defineConfig calls aipmConfigSchema.parse() internally — reuses the canonical validator
    // without requiring a separate export of the Zod schema from config.ts.
    defineConfig(rawConfig as AipmConfigInput);
    return [];
  } catch (err) {
    // ZodError carries .issues[] with path, code, message
    if (err instanceof z.ZodError) {
      return err.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return hard(
          'envelope-invalid',
          pluginName,
          `Invalid aipm.config: [${issuePath}] ${issue.message}`,
        );
      });
    }
    // Non-ZodError (e.g. JSON parse) — emit a single finding
    const message = err instanceof Error ? err.message : String(err);
    return [hard('envelope-invalid', pluginName, `Invalid aipm.config: ${message}`)];
  }
}

// ---------------------------------------------------------------------------
// validateEnvelopeAdherence
// ---------------------------------------------------------------------------

/**
 * For each target in the envelope: verify the plugin provides the minimum required artifacts.
 * For each target NOT in the envelope: verify no target-specific artifacts exist for it.
 *
 * Emits `envelope-adherence` findings.
 */
export function validateEnvelopeAdherence(
  pluginDir: string,
  envelope: readonly TargetId[],
): Finding[] {
  const findings: Finding[] = [];
  const envelopeSet = new Set(envelope);
  const pluginName = path.basename(pluginDir);

  // Check owned artifacts for targets NOT in the envelope
  for (const [target, artifacts] of Object.entries(TARGET_OWNED_ARTIFACTS) as [
    TargetId,
    string[],
  ][]) {
    if (envelopeSet.has(target)) continue;
    for (const artifact of artifacts) {
      const full = path.join(pluginDir, artifact);
      if (fs.existsSync(full)) {
        findings.push(
          hard(
            'envelope-adherence',
            pluginName,
            `Artifact '${artifact}' exists but target '${target}' is not in the support envelope.`,
            `Remove '${artifact}' or add '${target}' to the targets array in aipm.config.ts.`,
          ),
        );
      }
    }
  }

  // Check shared artifacts: must not exist if none of anyOf is in envelope
  for (const { file, anyOf } of SHARED_ARTIFACTS) {
    const full = path.join(pluginDir, file);
    if (fs.existsSync(full) && !anyOf.some((t) => envelopeSet.has(t))) {
      findings.push(
        hard(
          'envelope-adherence',
          pluginName,
          `Artifact '${file}' exists but none of [${anyOf.join(', ')}] is in the support envelope.`,
          `Remove '${file}' or add at least one of [${anyOf.join(', ')}] to the targets array in aipm.config.ts.`,
        ),
      );
    }
  }

  // Check minimum required artifacts for targets IN the envelope
  for (const target of envelope) {
    const required = TARGET_MIN_REQUIRED[target];
    for (const artifact of required) {
      const full = path.join(pluginDir, artifact);
      if (!fs.existsSync(full)) {
        findings.push(
          hard(
            'envelope-adherence',
            pluginName,
            `Target '${target}' is in the support envelope but required artifact '${artifact}' is missing.`,
            `Create '${artifact}' to satisfy the '${target}' target.`,
          ),
        );
      }
    }

    // Vercel special case: require at least one skills/*/SKILL.md (one level deep)
    if (target === 'vercel') {
      const skillsDir = path.join(pluginDir, 'skills');
      let hasSkill = false;
      if (fs.existsSync(skillsDir)) {
        try {
          const subdirs = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const dirent of subdirs) {
            if (dirent.isDirectory()) {
              const skillMd = path.join(skillsDir, dirent.name, 'SKILL.md');
              if (fs.existsSync(skillMd)) {
                hasSkill = true;
                break;
              }
            }
          }
        } catch {
          // Unreadable directory — treat as no skills
        }
      }
      if (!hasSkill) {
        findings.push(
          hard(
            'envelope-adherence',
            pluginName,
            `Target 'vercel' is in the support envelope but no 'skills/*/SKILL.md' file was found.`,
            `Create at least one skill under 'skills/<skill-name>/SKILL.md'.`,
          ),
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// validateNameConsistency
// ---------------------------------------------------------------------------

/**
 * Check that the plugin directory name matches the `name` field in every declared target's
 * manifest. Reads each manifest and parses its `name` field (doesn't re-run the full schema —
 * just extracts name).
 *
 * Emits `name-consistency` findings, one per mismatched manifest.
 */
export function validateNameConsistency(
  pluginDir: string,
  envelope: readonly TargetId[],
): Finding[] {
  const findings: Finding[] = [];
  const expectedName = path.basename(pluginDir);

  for (const target of envelope) {
    switch (target) {
      case 'claude': {
        const manifestPath = path.join(pluginDir, '.claude-plugin/plugin.json');
        if (!fs.existsSync(manifestPath)) break;
        const manifest = tryReadJson(manifestPath);
        const parsed = z.object({ name: z.string().optional() }).loose().safeParse(manifest);
        if (!parsed.success || parsed.data.name === undefined) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'.claude-plugin/plugin.json' has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
            ),
          );
        }
        break;
      }
      case 'cursor': {
        const manifestPath = path.join(pluginDir, '.cursor-plugin/plugin.json');
        if (!fs.existsSync(manifestPath)) break;
        const manifest = tryReadJson(manifestPath);
        const parsed = z.object({ name: z.string().optional() }).loose().safeParse(manifest);
        if (!parsed.success || parsed.data.name === undefined) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'.cursor-plugin/plugin.json' has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
            ),
          );
        }
        break;
      }
      case 'gemini': {
        const manifestPath = path.join(pluginDir, 'gemini-extension.json');
        if (!fs.existsSync(manifestPath)) break;
        const manifest = tryReadJson(manifestPath);
        const parsed = z.object({ name: z.string() }).loose().safeParse(manifest);
        if (!parsed.success) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'gemini-extension.json' has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
            ),
          );
        }
        break;
      }
      case 'kiro': {
        const powerMdPath = path.join(pluginDir, 'POWER.md');
        if (!fs.existsSync(powerMdPath)) break;
        const fm = tryParseFrontmatter(powerMdPath);
        const parsed = z.object({ name: z.string() }).loose().safeParse(fm);
        if (!parsed.success) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'POWER.md' frontmatter has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
            ),
          );
        }
        break;
      }
      case 'vercel': {
        // Vercel has no top-level plugin name field — skip
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// validateMcpKeySync
// ---------------------------------------------------------------------------

/**
 * When both Claude/Cursor (.mcp.json) and Kiro (mcp.json) are in the envelope, the set of
 * mcpServers keys must match between them. Skip the check if fewer than two MCP-consuming
 * targets are in the envelope.
 *
 * Emits `mcp-key-sync` findings.
 */
export function validateMcpKeySync(pluginDir: string, envelope: readonly TargetId[]): Finding[] {
  const pluginName = path.basename(pluginDir);
  const envelopeSet = new Set(envelope);

  const hasClaudeOrCursor = envelopeSet.has('claude') || envelopeSet.has('cursor');
  const hasKiro = envelopeSet.has('kiro');

  // Need at least one of Claude/Cursor AND Kiro to do a cross-target compare
  if (!hasClaudeOrCursor || !hasKiro) return [];

  const claudeCursorMcpPath = path.join(pluginDir, '.mcp.json');
  const kiroMcpPath = path.join(pluginDir, 'mcp.json');

  // If either file is missing, skip the sync check (adherence check handles missing files)
  if (!fs.existsSync(claudeCursorMcpPath) || !fs.existsSync(kiroMcpPath)) return [];

  const claudeCursorRaw = tryReadJson(claudeCursorMcpPath);
  const kiroRaw = tryReadJson(kiroMcpPath);

  const claudeCursorParsed = mcpConfigSchema.safeParse(claudeCursorRaw);
  const kiroParsed = mcpConfigSchema.safeParse(kiroRaw);

  if (!claudeCursorParsed.success || !kiroParsed.success) return [];

  const claudeCursorKeys = Object.keys(claudeCursorParsed.data.mcpServers ?? {}).sort();
  const kiroKeys = Object.keys(kiroParsed.data.mcpServers ?? {}).sort();

  if (JSON.stringify(claudeCursorKeys) === JSON.stringify(kiroKeys)) return [];

  const onlyInClaudeCursor = claudeCursorKeys.filter((k) => !kiroKeys.includes(k));
  const onlyInKiro = kiroKeys.filter((k) => !claudeCursorKeys.includes(k));

  const details: string[] = [];
  if (onlyInClaudeCursor.length > 0) {
    details.push(`.mcp.json only: [${onlyInClaudeCursor.join(', ')}]`);
  }
  if (onlyInKiro.length > 0) {
    details.push(`mcp.json only: [${onlyInKiro.join(', ')}]`);
  }

  return [
    hard(
      'mcp-key-sync',
      pluginName,
      `mcpServers keys diverge between '.mcp.json' and 'mcp.json'. ${details.join('; ')}.`,
      `Ensure both files declare the same set of server keys.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// validateMarketplaceRegistration
// ---------------------------------------------------------------------------

/**
 * Verify the plugin is listed in the appropriate template-level marketplace.json files.
 *
 * - If `claude` is in the envelope, the plugin MUST appear in `<repoRoot>/.claude-plugin/marketplace.json`'s
 *   plugins array with name matching directory basename and source pointing at `./plugins/<name>`.
 * - If `cursor` is in the envelope, same check against `<repoRoot>/.cursor-plugin/marketplace.json`.
 * - If a target is NOT in the envelope, the plugin MUST NOT be listed in that marketplace.
 *
 * Emits `marketplace-registration` findings.
 */
export function validateMarketplaceRegistration(
  pluginDir: string,
  repoRoot: string,
  envelope: readonly TargetId[],
): Finding[] {
  const findings: Finding[] = [];
  const pluginName = path.basename(pluginDir);
  const envelopeSet = new Set(envelope);

  const checks = [
    {
      target: 'claude' as TargetId,
      marketplacePath: path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
    },
    {
      target: 'cursor' as TargetId,
      marketplacePath: path.join(repoRoot, '.cursor-plugin', 'marketplace.json'),
    },
  ];

  for (const { target, marketplacePath } of checks) {
    const inEnvelope = envelopeSet.has(target);

    if (!fs.existsSync(marketplacePath)) {
      if (inEnvelope) {
        findings.push(
          hard(
            'marketplace-registration',
            pluginName,
            `Target '${target}' is in the support envelope but marketplace file '${marketplacePath}' does not exist.`,
            `Create the marketplace.json file at '${marketplacePath}'.`,
          ),
        );
      }
      // If not in envelope and no marketplace file, nothing to check
      continue;
    }

    const raw = tryReadJson(marketplacePath);
    const parsed = marketplaceSchema.safeParse(raw);

    if (!parsed.success) {
      if (inEnvelope) {
        findings.push(
          hard(
            'marketplace-registration',
            pluginName,
            `Failed to parse marketplace file '${marketplacePath}'.`,
          ),
        );
      }
      continue;
    }

    const { plugins } = parsed.data;

    // Normalize: both `./plugins/<name>` and `plugins/<name>` are accepted
    // The canonical expected form is `./plugins/<name>` per §4.4
    const expectedSource = `./plugins/${pluginName}`;
    const normalizedExpected = `plugins/${pluginName}`;

    const matchingEntry = plugins.find((p) => p.name === pluginName);

    if (inEnvelope) {
      if (!matchingEntry) {
        findings.push(
          hard(
            'marketplace-registration',
            pluginName,
            `Plugin '${pluginName}' is not listed in '${marketplacePath}'.`,
            `Add an entry with name '${pluginName}' and source '${expectedSource}' to the plugins array.`,
          ),
        );
      } else {
        // Entry exists — verify source
        const normalizedActual = matchingEntry.source.startsWith('./')
          ? matchingEntry.source.slice(2)
          : matchingEntry.source;
        if (normalizedActual !== normalizedExpected) {
          findings.push(
            hard(
              'marketplace-registration',
              pluginName,
              `Plugin '${pluginName}' in '${marketplacePath}' has source '${matchingEntry.source}' but expected '${expectedSource}'.`,
              `Update the source to '${expectedSource}'.`,
            ),
          );
        }
      }
    } else {
      // NOT in envelope — must not appear in marketplace
      if (matchingEntry) {
        findings.push(
          hard(
            'marketplace-registration',
            pluginName,
            `Plugin '${pluginName}' appears in '${marketplacePath}' but target '${target}' is not in the support envelope.`,
            `Remove '${pluginName}' from the marketplace or add '${target}' to the targets array in aipm.config.ts.`,
          ),
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// validateCrossTarget
// ---------------------------------------------------------------------------

/**
 * Convenience: run all cross-target validators for a single plugin and combine findings.
 * Stage 5's pipeline operations.ts uses this.
 *
 * Note: validateEnvelopeShape is excluded here because the caller must already have a
 * parsed envelope (TargetId[]) — meaning shape validation already passed. Shape validation
 * must be done separately before calling this function.
 */
export function validateCrossTarget(
  pluginDir: string,
  repoRoot: string,
  envelope: readonly TargetId[],
): Finding[] {
  return [
    ...validateEnvelopeAdherence(pluginDir, envelope),
    ...validateNameConsistency(pluginDir, envelope),
    ...validateMcpKeySync(pluginDir, envelope),
    ...validateMarketplaceRegistration(pluginDir, repoRoot, envelope),
  ];
}

// ---------------------------------------------------------------------------
// Per-target schema validation dispatch (§10.1 step 2)
// ---------------------------------------------------------------------------

/**
 * Per-target schema/filesystem validators, keyed by target ID. Each runs the corresponding
 * target's `validate.ts` entry point and returns its findings (mostly `schema-invalid`). The
 * orchestrator dispatches only for targets in the envelope.
 */
const TARGET_VALIDATORS: Record<TargetId, (pluginDir: string) => Finding[]> = {
  claude: validateClaudePlugin,
  cursor: validateCursorPlugin,
  gemini: validateGeminiPlugin,
  kiro: validateKiroPlugin,
  vercel: validateVercelPlugin,
};

/**
 * Run per-target schema validation for every target in the envelope (§10.1 step 2). Each
 * declared target's `validate.ts` validator is invoked; absent targets are skipped.
 */
function validatePerTargetSchemas(pluginDir: string, envelope: readonly TargetId[]): Finding[] {
  const findings: Finding[] = [];
  for (const target of envelope) {
    findings.push(...TARGET_VALIDATORS[target](pluginDir));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Freshness check (§10.5)
// ---------------------------------------------------------------------------

/**
 * Build a `freshness` Finding. Severity is `hard` in CI (a stale tree must fail the build) and
 * `soft` locally (a warning the author can act on), per §10.2.
 */
function freshnessFinding(
  ci: boolean,
  pluginName: string,
  message: string,
  hint?: string,
): Finding {
  return {
    severity: ci ? 'hard' : 'soft',
    code: 'freshness',
    plugin: pluginName,
    message,
    ...(hint !== undefined ? { hint } : {}),
  };
}

/**
 * Freshness check for one plugin (§10.5). A generated file is stale when re-running `aipm build`
 * would change it. Two carriers:
 *
 * 1. **In-plugin hook JSONs** (`hooks/claude.json`, `hooks/hooks.json`) — recompute the expected
 *    bytes (transform + `_generated` sentinel) and compare to disk. A missing file, an absent or
 *    altered sentinel, or any byte difference (e.g. a hand-edit) is stale.
 * 2. **`dist/**` bundle trees** — regenerate into a temp dir and byte-compare the whole tree
 *    (file set + contents). Any divergence names the offending path.
 *
 * Generation logic is shared with `runBuild` via `computePluginHookArtifacts` / `computeDistBundles`
 * so build output and the freshness oracle cannot drift.
 */
function checkFreshness(
  pluginDir: string,
  distDir: string,
  envelope: readonly TargetId[],
  ci: boolean,
): Finding[] {
  const findings: Finding[] = [];
  const pluginName = path.basename(pluginDir);

  // ── In-plugin hook JSONs ──────────────────────────────────────────────────
  let hookArtifacts: ReturnType<typeof computePluginHookArtifacts>;
  try {
    hookArtifacts = computePluginHookArtifacts(pluginDir, envelope);
  } catch (err) {
    // A malformed hooks source means the transform can't run — surface as freshness drift.
    const message = err instanceof Error ? err.message : String(err);
    return [
      freshnessFinding(
        ci,
        pluginName,
        `Unable to compute expected hook output: ${message}`,
        `fix the hooks source and run \`aipm build\`.`,
      ),
    ];
  }

  for (const artifact of hookArtifacts) {
    const rel = path.relative(pluginDir, artifact.absPath);
    if (!fs.existsSync(artifact.absPath)) {
      findings.push(
        freshnessFinding(
          ci,
          pluginName,
          `Generated file '${rel}' is missing.`,
          `run \`aipm build\` to generate it.`,
        ),
      );
      continue;
    }
    const onDisk = fs.readFileSync(artifact.absPath, 'utf-8');
    if (onDisk !== artifact.expectedContent) {
      findings.push(
        freshnessFinding(
          ci,
          pluginName,
          `Generated file '${rel}' is stale — it differs from what \`aipm build\` would produce (hand-edited or out of date).`,
          `run \`aipm build\` to regenerate it; edit the source '${artifact.source}', not the generated file.`,
        ),
      );
    }
  }

  // ── dist/** bundle trees (byte-parity via regeneration) ───────────────────
  for (const bundle of computeDistBundles(pluginDir, distDir, envelope)) {
    let tempDir: string | undefined;
    try {
      tempDir = regenerateBundleToTemp(bundle);
      const drift = compareTrees(bundle.destDir, tempDir);
      for (const rel of drift) {
        const distRel = path.relative(distDir, path.join(bundle.destDir, rel));
        findings.push(
          freshnessFinding(
            ci,
            pluginName,
            `Generated bundle file 'dist/${distRel}' is stale — it differs from what \`aipm build\` would produce.`,
            `run \`aipm build\` to regenerate the ${bundle.target} bundle.`,
          ),
        );
      }
    } finally {
      if (tempDir !== undefined && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    }
  }

  return findings;
}

/**
 * Compare two directory trees and return the relative paths that differ (present in only one
 * side, or present in both with differing bytes). An empty result means the trees are identical.
 */
function compareTrees(actualDir: string, expectedDir: string): string[] {
  const actual = new Set(collectFilesRelative(actualDir));
  const expected = new Set(collectFilesRelative(expectedDir));
  const drift = new Set<string>();

  for (const rel of actual) {
    if (!expected.has(rel)) {
      drift.add(rel);
      continue;
    }
    const a = fs.readFileSync(path.join(actualDir, rel));
    const b = fs.readFileSync(path.join(expectedDir, rel));
    if (!a.equals(b)) drift.add(rel);
  }
  for (const rel of expected) {
    if (!actual.has(rel)) drift.add(rel);
  }

  return [...drift].sort();
}

// ---------------------------------------------------------------------------
// runValidate — the validate orchestrator (§5.3, §10.1, §10.3)
// ---------------------------------------------------------------------------

/**
 * Validate one plugin or every plugin under a repo root (§5.3). Runs the validators in the order
 * mandated by §10.1 / §10.3:
 *
 *   1. Envelope load + shape validation. A load/shape failure emits `envelope-invalid` and
 *      **skips all further checks for that plugin** (no point validating an undeclared target).
 *   2. Per-target schema validation (each declared target's `validate.ts`). Schema errors
 *      **block cross-target checks** for that plugin (§10.3).
 *   3. Envelope adherence.
 *   4. Cross-target consistency (only when the envelope has more than one target and no blocking
 *      schema errors): name consistency, MCP key sync, marketplace registration.
 *   5. Freshness (unless `opts.skipFreshness`). Severity is `hard` in CI, `soft` locally (§10.2).
 *
 * `passed` is `true` iff no **hard** findings were emitted (§10.2).
 *
 * @param targetPath - Absolute path to a single plugin directory or a repo root.
 * @param opts - Validate options. `ci` controls freshness severity (default: local/soft).
 * @returns The combined validation result.
 */
export async function runValidate(
  targetPath: string,
  opts?: ValidateOptions & { ci?: boolean },
): Promise<ValidationResult> {
  const ci = opts?.ci ?? false;
  const skipFreshness = opts?.skipFreshness ?? false;

  const { repoRoot, distDir, pluginDirs } = discoverPlugins(targetPath);
  const findings: Finding[] = [];

  for (const pluginDir of pluginDirs) {
    const pluginName = path.basename(pluginDir);

    // ── 1. Envelope load + shape validation ─────────────────────────────────
    let envelope: readonly TargetId[];
    try {
      const config = await loadPluginConfig(pluginDir);
      envelope = config.targets;
    } catch (err) {
      // Distinguish "no/invalid config" (envelope-invalid) from unexpected errors. Either way,
      // the envelope is unusable, so we skip every downstream check for this plugin.
      const message =
        err instanceof ConfigLoadError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      findings.push({
        severity: 'hard',
        code: 'envelope-invalid',
        plugin: pluginName,
        message,
      });
      continue;
    }

    // ── 2. Per-target schema validation ─────────────────────────────────────
    const schemaFindings = validatePerTargetSchemas(pluginDir, envelope);
    findings.push(...schemaFindings);
    const hasBlockingSchemaError = schemaFindings.some((f) => f.severity === 'hard');

    // ── 3. Envelope adherence ───────────────────────────────────────────────
    findings.push(...validateEnvelopeAdherence(pluginDir, envelope));

    // ── 4. Cross-target consistency (§10.1 step 4: multi-target only; §10.3: schema blocks) ──
    if (envelope.length > 1 && !hasBlockingSchemaError) {
      findings.push(...validateNameConsistency(pluginDir, envelope));
      findings.push(...validateMcpKeySync(pluginDir, envelope));
      findings.push(...validateMarketplaceRegistration(pluginDir, repoRoot, envelope));
    }

    // ── 5. Freshness ─────────────────────────────────────────────────────────
    if (!skipFreshness) {
      findings.push(...checkFreshness(pluginDir, distDir, envelope, ci));
    }
  }

  const passed = !findings.some((f) => f.severity === 'hard');
  return { findings, passed };
}
