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
import { validateCodexPlugin } from '../targets/codex/validate.js';
import { validateCursorPlugin } from '../targets/cursor/validate.js';
import { validateGeminiPlugin } from '../targets/gemini/validate.js';
import { validateKiroPlugin } from '../targets/kiro/validate.js';
import { validateOpenPluginsPlugin } from '../targets/open-plugins/validate.js';
import { validateVercelPlugin } from '../targets/vercel/validate.js';
import {
  collectFilesRelative,
  collectRegistryPlugins,
  computeDistBundles,
  computePluginHookArtifacts,
  computeRegistryArtifacts,
  computeRootArtifacts,
  detectRootCollisions,
  isRootRegistryTarget,
  managedRegistryPaths,
  managedVendorRegistryPaths,
  mergeRootArtifacts,
  readRootManifestPaths,
  regenerateBundleToTemp,
  rootManifestPath,
  rootRegistryArtifactFiles,
  serializeRootManifest,
} from './build.js';
import type { RegistryArtifact } from './build.js';
import { discoverPlugins } from './discover.js';
import {
  ConfigLoadError,
  createConfigCache,
  loadPluginConfig,
  loadWorkspaceConfig,
} from './load-config.js';
import type { ConfigCache } from './load-config.js';
import type { AipmWorkspace } from '../config.js';
import type { Finding, TargetId, ValidateOptions, ValidationResult } from './types.js';
import { withoutGeneratorVersion } from './sentinel.js';
import { createRuleContext } from '../lint/context.js';
import { diagnosticToFinding } from '../lint/diagnostic.js';
import {
  defaultMarketplaceNameRule,
  envelopeAdherenceRule,
  frontmatterParsesRule,
  marketplaceRegistrationRule,
  mcpKeySyncRule,
  nameConsistencyRule,
  pluginFreshnessRule,
  registryFreshnessRule,
  rootArtifactFreshnessRule,
  targetSchemaRule,
} from '../lint/rules/index.js';

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
  codex: ['.codex-plugin/plugin.json', '.codex-plugin'],
  cursor: ['.cursor-plugin/plugin.json', '.cursor-plugin'],
  gemini: ['gemini-extension.json', 'GEMINI.md'],
  kiro: ['POWER.md', 'mcp.json'],
  'open-plugins': ['.plugin/plugin.json', '.plugin'],
  vercel: [],
};

/**
 * Shared artifacts that require at least one of the listed targets in the envelope.
 * `.mcp.json` is the Claude/Cursor/Codex MCP config format, shared between those targets.
 */
const SHARED_ARTIFACTS: { file: string; anyOf: TargetId[] }[] = [
  { file: '.mcp.json', anyOf: ['claude', 'codex', 'cursor', 'open-plugins'] },
];

/**
 * Minimum required artifacts for each target. Missing any of these when the target is
 * in the envelope is an adherence violation.
 * Vercel requires at least one skills/<name>/SKILL.md — handled specially below.
 */
export const TARGET_MIN_REQUIRED: Record<TargetId, string[]> = {
  claude: ['.claude-plugin/plugin.json'],
  codex: ['.codex-plugin/plugin.json'],
  cursor: ['.cursor-plugin/plugin.json'],
  gemini: ['gemini-extension.json'],
  kiro: ['POWER.md'],
  'open-plugins': ['.plugin/plugin.json'],
  vercel: [],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Zod schema for a string-source marketplace.json (Claude/Cursor). Loose to tolerate
 * extra metadata fields. Each plugin entry's `source` is the canonical `./plugins/<name>` string.
 */
const stringSourceMarketplaceSchema = z
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

/**
 * Minimal Zod schema for the Codex repo marketplace at `.agents/plugins/marketplace.json`. Its
 * entries differ from Claude/Cursor: `source` is an object `{ source, path }` (the comparable
 * path lives at `source.path`), plus `policy`/`category` metadata that is tolerated but not
 * checked here. Loose to tolerate extra fields.
 *
 * @see https://developers.openai.com/codex/plugins/build
 */
const objectSourceMarketplaceSchema = z
  .object({
    plugins: z.array(
      z
        .object({
          name: z.string(),
          source: z
            .object({
              source: z.string(),
              path: z.string(),
            })
            .loose(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * A per-registry descriptor for {@link validateMarketplaceRegistration}. Each target's repo
 * marketplace differs in file location and entry shape, so the descriptor captures both the path
 * (relative to repo root) and a function that extracts the comparable source string from a parsed
 * plugins array. The validator loop is otherwise identical across registries.
 */
/**
 * Outcome of extracting a plugin's marketplace source. A discriminated union (rather than a
 * `string | 'sentinel'` union, which a redundant-constituent lint rule would reject) so the
 * `'found'` case can carry the comparable source string while the sentinels stay distinct:
 *   - `parse-error`: the file did not match this registry's schema.
 *   - `not-listed`: the file parsed but contains no entry named the queried plugin.
 *   - `found`: an entry exists; `source` is the value to normalise and compare to `./plugins/<name>`.
 */
type SourceExtraction =
  | { status: 'parse-error' }
  | { status: 'not-listed' }
  | { status: 'found'; source: string };

interface MarketplaceRegistryDescriptor {
  target: TargetId;
  /** Path segments under the repo root locating this registry's marketplace.json. */
  marketplaceRel: string[];
  /** Parse the marketplace file and report whether the queried plugin is present, and its source. */
  extractSource: (raw: unknown, pluginName: string) => SourceExtraction;
}

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

/**
 * Matches a YAML frontmatter block, anchored to the **start of the file** (after an optional
 * UTF-8 BOM). No `m` flag — so a `---` thematic break in the markdown body is never mistaken
 * for frontmatter — and `\r?\n` so CRLF (Windows) checkouts are detected too. Group 1 is the
 * YAML between the fences.
 */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/;

/**
 * Strict-parse a file's YAML frontmatter, returning the parse-error message (first line,
 * which carries the line/column) or undefined when it parses cleanly. A missing file or a
 * file with no leading `---` frontmatter block is treated as "nothing to validate"
 * (undefined) — the presence/shape of required fields is a separate concern handled elsewhere.
 */
function frontmatterParseError(filePath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return undefined;
  try {
    parseYaml(match[1] ?? '');
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split('\n')[0];
  }
}

/**
 * Validate that every frontmatter-bearing markdown file in a plugin parses as strict YAML.
 *
 * Hosts differ in how leniently they read skill/agent frontmatter: Claude Code's loader is
 * forgiving, but strict YAML consumers — notably Codex's skill loader — reject anything that
 * is not valid YAML and refuse to load the skill. The classic offender is an unquoted value
 * containing a `": "` (colon-space), e.g. `description: ... acts as a liaison: it syncs ...`,
 * which YAML reads as an illegal nested mapping. Such a file loads on a lenient host and
 * fails on a strict one, so a lenient-host-only validator never catches it. We strict-parse
 * here so the defect surfaces at validate time for every plugin, host-agnostically.
 *
 * Covers the plugin's `POWER.md`, every `skills/<name>/SKILL.md`, and each `agents/*.md` and
 * `commands/*.md` file.
 *
 * @see https://yaml.org/spec/1.2.2/#732-block-mappings — why `": "` in a plain scalar parses as a mapping
 */
export function validateFrontmatterParses(pluginDir: string, pluginName: string): Finding[] {
  const files: string[] = [path.join(pluginDir, 'POWER.md')];

  // skills/<name>/SKILL.md — one directory level deep, mirroring discovery elsewhere.
  const skillsDir = path.join(pluginDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(path.join(skillsDir, entry.name, 'SKILL.md'));
    }
  }

  // agents/*.md and commands/*.md — flat directories of frontmatter-bearing markdown.
  for (const sub of ['agents', 'commands'] as const) {
    const dir = path.join(pluginDir, sub);
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
    }
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const error = frontmatterParseError(file);
    if (error !== undefined) {
      findings.push(
        hard(
          'frontmatter-invalid',
          pluginName,
          `Invalid YAML frontmatter in '${path.relative(pluginDir, file)}': ${error}`,
          `Frontmatter must be valid YAML for strict hosts (e.g. Codex), not only Claude's lenient parser. A common cause is an unquoted ': ' (colon-space) inside a value such as 'description' — quote the value or rephrase to remove the colon.`,
        ),
      );
    }
  }
  return findings;
}

/** Build a hard Finding. */
function hard(code: Finding['code'], plugin: string, message: string, hint?: string): Finding {
  return { severity: 'hard', code, plugin, message, ...(hint !== undefined ? { hint } : {}) };
}

// ---------------------------------------------------------------------------
// Default / placeholder marketplace name check
// ---------------------------------------------------------------------------

/**
 * Marketplace `name` values that are template placeholders, not a real identity. `ai-plugin-marketplace`
 * is the upstream template repo's own name (a fork that never renamed collides with upstream);
 * `my-ai-plugins` is the placeholder the template ships and the fallback `aipm init` writes when
 * `$USER` is unset (intentionally flagged so the author is nudged to pass `--name`).
 */
const PLACEHOLDER_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  'ai-plugin-marketplace',
  'my-ai-plugins',
]);

/**
 * Marketplace `owner.name` values that are template placeholders rather than a real owner.
 */
const PLACEHOLDER_OWNER_NAMES: ReadonlySet<string> = new Set([
  'AI Plugin Marketplace Template',
  'Your Name',
]);

/** Schema for the marketplace metadata this check reads from a generated registry JSON. */
const registryMetadataSchema = z
  .object({
    name: z.string().optional(),
    owner: z.object({ name: z.string().optional() }).loose().optional(),
  })
  .loose();

/**
 * The repo's effective marketplace identity, however the repo declares it: from `aipm.workspace.ts`
 * (registry generation opted in) or, failing that, from a committed repo-root registry's top-level
 * `name`/`owner.name`. `undefined` fields mean "not declared" — the caller emits nothing for them.
 */
interface MarketplaceIdentity {
  name?: string;
  ownerName?: string;
}

/**
 * Resolve the repo's effective marketplace identity for the default-name check. Prefers the
 * authored `aipm.workspace.ts` (which `runValidate` already loaded) and falls back to reading a
 * committed repo-root registry's top-level `name`/`owner.name` (the hand-authored / `aipm init`
 * path, where no workspace exists). The first managed registry that parses and declares a `name`
 * OR an `owner.name` wins; all generated registries carry the same marketplace identity, so any
 * one is representative.
 */
function resolveMarketplaceIdentity(
  repoRoot: string,
  workspace: AipmWorkspace | undefined,
): MarketplaceIdentity {
  if (workspace !== undefined) {
    const { marketplace } = workspace;
    return {
      name: marketplace.name,
      ...(marketplace.owner !== undefined ? { ownerName: marketplace.owner.name } : {}),
    };
  }

  for (const registryPath of managedRegistryPaths(repoRoot)) {
    if (!fs.existsSync(registryPath)) continue;
    const parsed = registryMetadataSchema.safeParse(tryReadJson(registryPath));
    if (!parsed.success) continue;
    const { name, owner } = parsed.data;
    // Only treat this registry as the identity source once it declares a `name` or an `owner.name`;
    // an empty `{ "plugins": [] }` registry carries no identity, so keep scanning the others.
    if (name === undefined && owner?.name === undefined) continue;
    return {
      ...(name !== undefined ? { name } : {}),
      ...(owner?.name !== undefined ? { ownerName: owner.name } : {}),
    };
  }

  return {};
}

/**
 * Repo-level check: warn (SOFT) when the effective marketplace `name` or `owner.name` is still a
 * template placeholder. A placeholder name collides with the upstream `ai-plugin-marketplace`
 * marketplace (or any other fork that kept the default) — when two marketplaces register under the
 * same name, the later install shadows/strands the earlier's plugins. Emitting nothing when no
 * marketplace metadata is declared (an empty `aipm init` repo before any name is set).
 *
 * Always SOFT: this is advice the author should act on, never a reason to fail the build (it does
 * not flip `passed`).
 */
export function checkDefaultMarketplaceName(
  repoRoot: string,
  workspace: AipmWorkspace | undefined,
): Finding[] {
  const { name, ownerName } = resolveMarketplaceIdentity(repoRoot, workspace);
  const findings: Finding[] = [];

  if (name !== undefined && PLACEHOLDER_MARKETPLACE_NAMES.has(name)) {
    findings.push({
      severity: 'soft',
      code: 'default-marketplace-name',
      message: `Marketplace name '${name}' is a template default. Two marketplaces registered under the same name collide on install — the later one shadows/strands the earlier one's plugins (including the upstream 'ai-plugin-marketplace').`,
      hint: "Rename it to a unique value (convention: '<your-handle>-ai-plugins'): set marketplace.name in aipm.workspace.ts, or the top-level `name` in the repo-root registries (.claude-plugin/.cursor-plugin/marketplace.json) when there is no workspace. New repos can pass `aipm init --name <name>`.",
    });
  }

  if (ownerName !== undefined && PLACEHOLDER_OWNER_NAMES.has(ownerName)) {
    findings.push({
      severity: 'soft',
      code: 'default-marketplace-name',
      message: `Marketplace owner name '${ownerName}' is a template default, not a real owner.`,
      hint: 'Set marketplace.owner.name in aipm.workspace.ts (or the repo-root registries) to your name or organization.',
    });
  }

  return findings;
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
/**
 * Format a Zod validation failure's issues as `envelope-invalid` findings, one per issue. Shared
 * by {@link validateEnvelopeShape} (validates a raw value directly) and the `schema/envelope-shape`
 * lint rule (which instead catches the `ZodError` `defineConfig` throws via `loadPluginConfig`, so
 * the config is transpiled/validated exactly once per invocation rather than twice).
 */
export function zodEnvelopeIssuesToFindings(
  issues: z.core.$ZodIssue[],
  pluginName: string,
): Finding[] {
  return issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return hard(
      'envelope-invalid',
      pluginName,
      `Invalid aipm.config: [${issuePath}] ${issue.message}`,
    );
  });
}

export function validateEnvelopeShape(rawConfig: unknown, pluginName: string): Finding[] {
  try {
    // defineConfig calls aipmConfigSchema.parse() internally — reuses the canonical validator
    // without requiring a separate export of the Zod schema from config.ts.
    defineConfig(rawConfig as AipmConfigInput);
    return [];
  } catch (err) {
    // ZodError carries .issues[] with path, code, message
    if (err instanceof z.ZodError) {
      return zodEnvelopeIssuesToFindings(err.issues, pluginName);
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
      case 'codex': {
        const manifestPath = path.join(pluginDir, '.codex-plugin/plugin.json');
        if (!fs.existsSync(manifestPath)) break;
        const manifest = tryReadJson(manifestPath);
        const parsed = z.object({ name: z.string().optional() }).loose().safeParse(manifest);
        if (!parsed.success || parsed.data.name === undefined) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'.codex-plugin/plugin.json' has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
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
      case 'open-plugins': {
        const manifestPath = path.join(pluginDir, '.plugin/plugin.json');
        if (!fs.existsSync(manifestPath)) break;
        const manifest = tryReadJson(manifestPath);
        const parsed = z.object({ name: z.string().optional() }).loose().safeParse(manifest);
        if (!parsed.success || parsed.data.name === undefined) break;
        if (parsed.data.name !== expectedName) {
          findings.push(
            hard(
              'name-consistency',
              expectedName,
              `'.plugin/plugin.json' has name '${parsed.data.name}' but plugin directory is '${expectedName}'.`,
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
 * The marketplace registries this validator knows about, one descriptor per registry-backed
 * target. Claude/Cursor use string-source entries at `.<target>-plugin/marketplace.json`; Codex
 * uses an object-source entry (`source: { source, path }`) at `.agents/plugins/marketplace.json`.
 *
 * Keeping the per-registry differences (path + source extraction) in data lets the validation
 * loop below stay a single, shape-agnostic pass rather than duplicating it per registry.
 *
 * @see https://developers.openai.com/codex/plugins/build
 */
const MARKETPLACE_REGISTRY_CHECKS: MarketplaceRegistryDescriptor[] = [
  {
    target: 'claude',
    marketplaceRel: ['.claude-plugin', 'marketplace.json'],
    extractSource: extractStringSource,
  },
  {
    target: 'cursor',
    marketplaceRel: ['.cursor-plugin', 'marketplace.json'],
    extractSource: extractStringSource,
  },
  {
    target: 'codex',
    marketplaceRel: ['.agents', 'plugins', 'marketplace.json'],
    extractSource: extractCodexSource,
  },
  {
    target: 'open-plugins',
    marketplaceRel: ['marketplace.json'],
    extractSource: extractStringSource,
  },
];

/** Extract the string `source` of the matching entry from a string-source marketplace file. */
function extractStringSource(raw: unknown, pluginName: string): SourceExtraction {
  const parsed = stringSourceMarketplaceSchema.safeParse(raw);
  if (!parsed.success) return { status: 'parse-error' };
  const entry = parsed.data.plugins.find((p) => p.name === pluginName);
  if (!entry) return { status: 'not-listed' };
  return { status: 'found', source: entry.source };
}

/** Extract the matching entry's `source.path` from the Codex object-source marketplace file. */
function extractCodexSource(raw: unknown, pluginName: string): SourceExtraction {
  const parsed = objectSourceMarketplaceSchema.safeParse(raw);
  if (!parsed.success) return { status: 'parse-error' };
  const entry = parsed.data.plugins.find((p) => p.name === pluginName);
  if (!entry) return { status: 'not-listed' };
  return { status: 'found', source: entry.source.path };
}

/**
 * Verify the plugin is listed in the appropriate template-level marketplace.json files.
 *
 * - If `claude` is in the envelope, the plugin MUST appear in
 *   `<repoRoot>/.claude-plugin/marketplace.json`'s plugins array with a string `source` pointing
 *   at the plugin directory relative to the repo root (`./plugins/<name>` by default, or the
 *   relocated `pluginsRoot` for an embedded marketplace).
 * - If `cursor` is in the envelope, same check against `<repoRoot>/.cursor-plugin/marketplace.json`.
 * - If `codex` is in the envelope, the plugin MUST appear in
 *   `<repoRoot>/.agents/plugins/marketplace.json` with an object `source` whose `path` is
 *   `./plugins/<name>`.
 * - If a target is NOT in the envelope, the plugin MUST NOT be listed in that marketplace.
 *
 * The per-registry path and source extraction are data-driven (see
 * {@link MARKETPLACE_REGISTRY_CHECKS}); the loop body is identical across registries so the same
 * `not-listed` / wrong-path / present-but-not-in-envelope findings are emitted regardless of
 * source shape.
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

  // The expected source is the plugin directory's path relative to the repo root (the location
  // hosts resolve `source` against). Default topology → `plugins/<name>`; an embedded marketplace
  // with a relocated `pluginsRoot` → e.g. `agent-plugins/<name>`. POSIX separators are forced so
  // the comparison is stable on Windows. Both `./<rel>` and `<rel>` are accepted; the canonical
  // form carries the `./` prefix (§4.4).
  const relFromRepo = path.relative(repoRoot, pluginDir).split(path.sep).join('/');
  const expectedSource = `./${relFromRepo}`;
  const normalizedExpected = relFromRepo;

  for (const { target, marketplaceRel, extractSource } of MARKETPLACE_REGISTRY_CHECKS) {
    const marketplacePath = path.join(repoRoot, ...marketplaceRel);
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
    const extraction = extractSource(raw, pluginName);

    if (extraction.status === 'parse-error') {
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

    if (inEnvelope) {
      if (extraction.status === 'not-listed') {
        findings.push(
          hard(
            'marketplace-registration',
            pluginName,
            `Plugin '${pluginName}' is not listed in '${marketplacePath}'.`,
            `Add an entry with name '${pluginName}' and source '${expectedSource}' to the plugins array.`,
          ),
        );
      } else {
        // Entry exists — verify source (normalise a leading `./`).
        const { source } = extraction;
        const normalizedActual = source.startsWith('./') ? source.slice(2) : source;
        if (normalizedActual !== normalizedExpected) {
          findings.push(
            hard(
              'marketplace-registration',
              pluginName,
              `Plugin '${pluginName}' in '${marketplacePath}' has source '${source}' but expected '${expectedSource}'.`,
              `Update the source to '${expectedSource}'.`,
            ),
          );
        }
      }
    } else {
      // NOT in envelope — must not appear in marketplace
      if (extraction.status === 'found') {
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
  codex: validateCodexPlugin,
  cursor: validateCursorPlugin,
  gemini: validateGeminiPlugin,
  kiro: validateKiroPlugin,
  'open-plugins': validateOpenPluginsPlugin,
  vercel: validateVercelPlugin,
};

/**
 * Run per-target schema validation for every target in the envelope (§10.1 step 2). Each
 * declared target's `validate.ts` validator is invoked; absent targets are skipped.
 */
export function validatePerTargetSchemas(
  pluginDir: string,
  envelope: readonly TargetId[],
): Finding[] {
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
  pluginName: string | undefined,
  message: string,
  hint?: string,
): Finding {
  return {
    severity: ci ? 'hard' : 'soft',
    code: 'freshness',
    // Repo-level freshness (e.g. registries) has no owning plugin — omit the key entirely.
    ...(pluginName !== undefined ? { plugin: pluginName } : {}),
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
export function checkFreshness(
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
    // Compare modulo the generator-version stamp (§4.3.1): a differently-versioned but
    // content-identical artifact is NOT stale — version safety is the build downgrade guard's job,
    // not freshness's. Content, source, or structural drift still differs after normalization.
    const mode = artifact.sentinelMode;
    if (
      withoutGeneratorVersion(onDisk, mode) !==
      withoutGeneratorVersion(artifact.expectedContent, mode)
    ) {
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
 * Repo-level freshness check for the generated marketplace registries (design spec §"Marketplace
 * registries"). Runs ONLY when an `aipm.workspace.ts` is present (registry generation opted in).
 *
 * Registries are sentinel-less, so freshness is a whole-file regenerate-and-byte-compare: recompute
 * the expected bytes for every registry-backed target that some plugin declares, then compare to
 * the committed file. A missing file or any byte difference (drift, hand-edit, stale entry) is a
 * `freshness` finding — this is what subsumes the source-correctness half of
 * `validateMarketplaceRegistration` (a wrong `source` is now stale, not a separate finding).
 *
 * Generation logic is shared with `runBuild` via `collectRegistryPlugins`/`computeRegistryArtifacts`
 * so the build output and the freshness oracle cannot drift. Findings are repo-scoped (no `plugin`).
 */
export async function checkRegistryFreshness(
  repoRoot: string,
  pluginDirs: readonly string[],
  workspace: AipmWorkspace,
  ci: boolean,
  cache?: ConfigCache,
): Promise<Finding[]> {
  let expected: RegistryArtifact[];
  try {
    const registryPlugins = await collectRegistryPlugins(repoRoot, pluginDirs, cache);
    // Repo-root registries (open-plugins) are collision-guarded and freshness-checked via the
    // generated-root sidecar path (checkRootArtifactFreshness); exclude them here so their
    // missing/stale/orphan state is reported once, not double-counted.
    expected = computeRegistryArtifacts(repoRoot, registryPlugins, workspace).filter(
      (r) => !isRootRegistryTarget(r.target),
    );
  } catch (err) {
    // A plugin config that won't load is reported per-plugin as envelope-invalid elsewhere; here
    // we surface the inability to compute the registry oracle as repo-scoped freshness drift.
    const message = err instanceof Error ? err.message : String(err);
    return [
      freshnessFinding(
        ci,
        undefined,
        `Unable to compute expected marketplace registries: ${message}`,
        'fix the offending aipm.config.ts and run `aipm build`.',
      ),
    ];
  }

  const findings: Finding[] = [];
  for (const registry of expected) {
    const rel = path.relative(repoRoot, registry.absPath);
    if (!fs.existsSync(registry.absPath)) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated registry '${rel}' is missing.`,
          'run `aipm build` to generate it.',
        ),
      );
      continue;
    }
    const onDisk = fs.readFileSync(registry.absPath, 'utf-8');
    if (onDisk !== registry.expectedContent) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated registry '${rel}' is stale — it differs from what \`aipm build\` would produce (hand-edited or out of date).`,
          "run `aipm build` to regenerate it; edit `aipm.workspace.ts` / each plugin's `aipm.config.ts`, not the generated registry.",
        ),
      );
    }
  }

  // Orphan check: a managed registry committed for a target NO plugin declares anymore is not in
  // `expected`, so the loop above can't see it. Flag any managed registry path that exists on disk
  // but isn't expected — `aipm build` removes these, so its presence means the tree is stale.
  const expectedPaths = new Set(expected.map((r) => r.absPath));
  for (const orphan of managedVendorRegistryPaths(repoRoot)) {
    if (!expectedPaths.has(orphan) && fs.existsSync(orphan)) {
      const rel = path.relative(repoRoot, orphan);
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated registry '${rel}' is stale — no plugin declares its target, so \`aipm build\` would remove it.`,
          'run `aipm build` to remove the orphaned registry, or add a plugin that declares its target.',
        ),
      );
    }
  }

  return findings;
}

/**
 * Repo-level check for the single-artifact-host repo-root native artifacts (gemini / kiro), design
 * spec "Phase 1". Runs ONLY when an `aipm.workspace.ts` is present (the same opt-in gate as
 * registries). Surfaces three independent finding kinds:
 *
 * 1. **`single-artifact-host`** (always hard) — a host declared by more than one plugin. Comes
 *    straight from {@link computeRootArtifacts}'s N=1 gate, so build and validate agree exactly on
 *    which hosts are emittable.
 * 2. **`root-artifact-collision`** (always hard) — a generated root path is occupied by a file the
 *    toolkit does not track as previously-generated. Detected against the committed sidecar's
 *    tracked set, mirroring build's collision guard. (A collision detected at validate time is a
 *    finding even though build would have refused to write it.)
 * 3. **`freshness`** (hard in CI, soft locally) — for every emittable root file: missing or stale
 *    (byte-compare against `computeRootArtifacts`' bytes); for every path in the committed sidecar
 *    no longer expected but still on disk: orphaned/stale; and the sidecar manifest itself must
 *    match what `aipm build` would write.
 *
 * Generation logic is shared with `runBuild` via `computeRootArtifacts`/`detectRootCollisions`/
 * `serializeRootManifest`, so the build output and the freshness oracle cannot drift. Findings are
 * repo-scoped (no `plugin`).
 */
export async function checkRootArtifactFreshness(
  repoRoot: string,
  pluginDirs: readonly string[],
  workspace: AipmWorkspace,
  ci: boolean,
  skipFreshness: boolean,
  cache?: ConfigCache,
): Promise<Finding[]> {
  let root: ReturnType<typeof computeRootArtifacts>;
  try {
    const plugins = await collectRegistryPlugins(repoRoot, pluginDirs, cache);
    // Merge the repo-root registries (open-plugins) into the root-artifact set so ONE collision
    // guard, sidecar tracked-set, and orphan sweep cover every repo-root file the toolkit owns
    // (OP-D5/VT-4, option (a)). A foreign root marketplace.json therefore raises
    // `root-artifact-collision` and is never overwritten or orphan-removed.
    const rootRegistries = computeRegistryArtifacts(repoRoot, plugins, workspace).filter((r) =>
      isRootRegistryTarget(r.target),
    );
    root = mergeRootArtifacts(
      computeRootArtifacts(repoRoot, plugins, workspace),
      rootRegistryArtifactFiles(repoRoot, rootRegistries),
    );
  } catch (err) {
    // A plugin config that won't load is reported per-plugin as envelope-invalid elsewhere; only
    // surface the inability to compute the root oracle as freshness drift when freshness is checked.
    if (skipFreshness) return [];
    const message = err instanceof Error ? err.message : String(err);
    return [
      freshnessFinding(
        ci,
        undefined,
        `Unable to compute expected repo-root artifacts: ${message}`,
        'fix the offending aipm.config.ts and run `aipm build`.',
      ),
    ];
  }

  const findings: Finding[] = [];

  // 1. N=1 gate findings (always hard, own code). Surfaced regardless of `skipFreshness` so the
  // post-build validate (which skips freshness) still fails fast on an ambiguous host declaration.
  findings.push(...root.findings);

  // 2. Collision findings against the committed sidecar's tracked set (build's safety guard 3).
  // Also surfaced regardless of `skipFreshness` — a collision is a structural refusal, not drift.
  const priorTracked = readRootManifestPaths(repoRoot);
  const collisions = detectRootCollisions(repoRoot, root, priorTracked);
  const { collidedOwners } = collisions;
  findings.push(...collisions.findings);

  // The freshness-coded checks (missing/stale/orphan/sidecar) are skipped after a fresh build.
  if (skipFreshness) return findings;

  // 3a. The set of paths build WOULD write this run (excluding suppressed/collided hosts) — this is
  // the canonical expected tracked set the sidecar must match.
  const expectedTracked: string[] = [];
  for (const file of root.files) {
    if (collidedOwners.has(file.owner)) continue;
    const rel = file.relPath;
    expectedTracked.push(rel);
    const abs = path.join(repoRoot, ...rel.split('/'));
    if (!fs.existsSync(abs)) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated repo-root artifact '${rel}' is missing.`,
          'run `aipm build` to generate it.',
        ),
      );
      continue;
    }
    const onDisk = fs.readFileSync(abs);
    if (!onDisk.equals(file.content)) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated repo-root artifact '${rel}' is stale — it differs from what \`aipm build\` would produce (hand-edited or out of date).`,
          "run `aipm build` to regenerate it; edit the owning plugin's source, not the generated repo-root file.",
        ),
      );
    }
  }

  // 3b. Orphans: any path the committed sidecar recorded that build would no longer write but which
  // still sits on disk. `aipm build` removes these, so their presence means the tree is stale.
  const expectedSet = new Set(expectedTracked);
  for (const rel of priorTracked) {
    if (expectedSet.has(rel)) continue;
    const abs = path.join(repoRoot, ...rel.split('/'));
    if (fs.existsSync(abs)) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated repo-root artifact '${rel}' is stale — it is no longer produced, so \`aipm build\` would remove it.`,
          'run `aipm build` to remove the orphaned artifact.',
        ),
      );
    }
  }

  // 3c. The sidecar manifest itself is a generated, freshness-checked artifact: its bytes must
  // match what build would write for the expected tracked set. When build would write no artifacts
  // AND no sidecar exists, the expected state is "no sidecar" — only flag a stale/missing sidecar
  // when one is expected (non-empty tracked set) or one already exists on disk.
  const manifestAbs = rootManifestPath(repoRoot);
  const manifestExists = fs.existsSync(manifestAbs);
  if (expectedTracked.length > 0 || manifestExists) {
    const expectedManifest = serializeRootManifest(expectedTracked);
    if (!manifestExists) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated root manifest '${path.relative(repoRoot, manifestAbs)}' is missing.`,
          'run `aipm build` to generate it.',
        ),
      );
    } else if (fs.readFileSync(manifestAbs, 'utf-8') !== expectedManifest) {
      findings.push(
        freshnessFinding(
          ci,
          undefined,
          `Generated root manifest '${path.relative(repoRoot, manifestAbs)}' is stale — it differs from what \`aipm build\` would produce.`,
          'run `aipm build` to regenerate it.',
        ),
      );
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

  // Discovery loads the optional `aipm.repo.ts`. An invalid repo config makes the whole repo's
  // topology unresolvable, so surface it as a single repo-scoped `repo-config-invalid` finding
  // (parallel to how an unloadable plugin envelope becomes `envelope-invalid`) rather than letting
  // the thrown error escape the validator.
  let discovery;
  try {
    discovery = await discoverPlugins(targetPath);
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      return {
        findings: [{ severity: 'hard', code: 'repo-config-invalid', message: err.message }],
        passed: false,
      };
    }
    throw err;
  }
  const { repoRoot, distDir, pluginDirs } = discovery;
  const findings: Finding[] = [];

  // One per-invocation config memo so each plugin's aipm.config.ts is transpiled once — reused by
  // the main loop below and the repo-level registry freshness step (see ConfigCache).
  const configCache = createConfigCache();

  // Registry generation is opt-in via `aipm.workspace.ts`. When present, the marketplace registries
  // are GENERATED, so their correctness is enforced by the repo-level freshness check below and the
  // per-plugin `validateMarketplaceRegistration` is SKIPPED (it would otherwise double-report). When
  // absent, the historical hand-authored-registry path runs unchanged. An invalid workspace config
  // surfaces as a single repo-scoped finding (parallel to `repo-config-invalid`).
  let workspace: AipmWorkspace | undefined;
  try {
    workspace = await loadWorkspaceConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      return {
        findings: [{ severity: 'hard', code: 'repo-config-invalid', message: err.message }],
        passed: false,
      };
    }
    throw err;
  }
  const generatesRegistries = workspace !== undefined;

  for (const pluginDir of pluginDirs) {
    const pluginName = path.basename(pluginDir);

    // ── 1. Envelope load + shape validation ─────────────────────────────────
    let envelope: readonly TargetId[];
    try {
      const config = await loadPluginConfig(pluginDir, configCache);
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

    const ctx = createRuleContext({
      pluginDir,
      repoRoot,
      distDir,
      envelope,
      allPluginDirs: pluginDirs,
      workspace,
      ci,
      skipFreshness,
      configCache,
    });

    // ── 2. Per-target schema validation ─────────────────────────────────────
    const schemaFindings = (await targetSchemaRule.check(ctx)).map((d) =>
      diagnosticToFinding(d, ci),
    );
    findings.push(...schemaFindings);
    const hasBlockingSchemaError = schemaFindings.some((f) => f.severity === 'hard');

    // ── 3. Envelope adherence ───────────────────────────────────────────────
    findings.push(
      ...(await envelopeAdherenceRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)),
    );

    // ── 3b. Frontmatter validity ────────────────────────────────────────────
    // Host-agnostic: invalid YAML frontmatter loads on lenient hosts (Claude) but fails on
    // strict ones (Codex). Runs for every plugin regardless of target envelope.
    findings.push(
      ...(await frontmatterParsesRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)),
    );

    // ── 4. Cross-target consistency (§10.1 step 4: multi-target only; §10.3: schema blocks) ──
    if (envelope.length > 1 && !hasBlockingSchemaError) {
      findings.push(
        ...(await nameConsistencyRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)),
      );
      findings.push(...(await mcpKeySyncRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)));
      // When registries are generated, their correctness is enforced by freshness below — skip the
      // hand-authored-registry check to avoid double findings (design spec, locked decision 2).
      if (!generatesRegistries) {
        findings.push(
          ...(await marketplaceRegistrationRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)),
        );
      }
    }

    // ── 5. Freshness ─────────────────────────────────────────────────────────
    findings.push(...(await pluginFreshnessRule.check(ctx)).map((d) => diagnosticToFinding(d, ci)));
  }

  // ── 6. Repo-level default/placeholder marketplace-name check (always SOFT) ──
  // Marketplace identity is a REPO-level concern, so this runs only when validating a repo root
  // (not a single plugin directory — that path stays scoped to the one plugin and short-circuits
  // on envelope-invalid). Independent of registry generation: the effective name comes from
  // `aipm.workspace.ts` when present, else from a committed repo-root registry's top-level
  // `name`/`owner.name`. A placeholder name collides with the upstream marketplace and strands
  // plugins, so warn — but never fail (soft, does not flip `passed`).
  if (path.resolve(targetPath) === repoRoot) {
    const repoLevelCtx = createRuleContext({
      pluginDir: repoRoot,
      repoRoot,
      distDir,
      envelope: [],
      allPluginDirs: pluginDirs,
      workspace,
      ci,
      skipFreshness,
      configCache,
    });
    findings.push(
      ...(await defaultMarketplaceNameRule.check(repoLevelCtx)).map((d) =>
        diagnosticToFinding(d, ci),
      ),
    );
  }

  // ── 7. Repo-level generation checks (only when generation is opted in) ──────
  // Registries AND single-artifact-host root artifacts are repo-scoped, so these run once per repo
  // against EVERY plugin under the repo root — not just the plugins in `pluginDirs` (length-1 for
  // single-plugin input). That mirrors how `runBuild` regenerates the repo-complete output, so a
  // single-plugin validate of a repo with sibling plugins compares against the same expected bytes.
  //
  // The registry block is freshness-only (gated on `!skipFreshness`). The root-artifact block runs
  // whenever a workspace is present — even under `skipFreshness` — because its `single-artifact-host`
  // / `root-artifact-collision` findings are structural gates (not drift), and `runBuild`'s
  // post-build validate (which skips freshness) must still fail fast on them.
  if (workspace !== undefined) {
    // For repo-root input, pluginDirs already covers the whole repo — reuse it (and the warm
    // config cache) rather than re-discovering and reloading. Single-plugin input needs a
    // repo-wide re-scan so the oracle stays repo-complete.
    const isRepoRoot = path.resolve(targetPath) === repoRoot;
    const allPluginDirs = isRepoRoot ? pluginDirs : (await discoverPlugins(repoRoot)).pluginDirs;
    const repoScopedCtx = createRuleContext({
      pluginDir: repoRoot,
      repoRoot,
      distDir,
      envelope: [],
      allPluginDirs,
      workspace,
      ci,
      skipFreshness,
      configCache,
    });
    if (!skipFreshness) {
      findings.push(
        ...(await registryFreshnessRule.check(repoScopedCtx)).map((d) =>
          diagnosticToFinding(d, ci),
        ),
      );
    }
    findings.push(
      ...(await rootArtifactFreshnessRule.check(repoScopedCtx)).map((d) =>
        diagnosticToFinding(d, ci),
      ),
    );
  }

  const passed = !findings.some((f) => f.severity === 'hard');
  return { findings, passed };
}
