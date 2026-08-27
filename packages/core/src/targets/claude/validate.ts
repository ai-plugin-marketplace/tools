/**
 * Per-target validators for the Claude Code target.
 *
 * These checks go beyond schema shape validation — they verify filesystem facts and
 * cross-file consistency within the Claude target. Schema shape errors are caught by
 * `claudePluginManifestSchema` (Stage 2); the checks here require reading the filesystem.
 *
 * Cross-target concerns (envelope-adherence, name-consistency, mcp-key-sync,
 * marketplace-registration, freshness) are out of scope for this module.
 *
 * @see docs/specs/architecture.md §10 (validation contract), §8.1 (Finding types)
 * @see docs/specs/architecture.md §10.1.5 (auto-loaded `hooks/hooks.json`)
 * @see docs/specs/architecture.md §12.5 (internal module shape)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Finding } from '../../pipeline/types.js';
import {
  metadataDirConformanceFindings,
  nameGrammarConformanceFindings,
} from '../open-plugins-conformance.js';
import { hasTraversalSegment } from '../path-safety.js';
import {
  claudeAgentFrontmatterSchema,
  claudeHooksFileSchema,
  claudePluginManifestSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a hard `schema-invalid` Finding scoped to the given plugin.
 */
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

/**
 * Normalize a manifest field that can be a string path, an array of string paths,
 * or a non-path value (object/undefined). Returns only the string path entries.
 */
function normalizePathField(
  value: string | string[] | Record<string, unknown> | undefined,
): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  // Object value (inline hooks object, record of commands) — no paths to check
  return [];
}

// ---------------------------------------------------------------------------
// Manifest file-ref validation
// ---------------------------------------------------------------------------

/**
 * Validate that all file/directory references in `.claude-plugin/plugin.json`
 * resolve to real filesystem entries.
 *
 * Per §10.1: path refs must not contain `..` and must exist on disk.
 * Field-level invariants:
 *   - `skills`: the ref must point to a directory
 *   - `agents`: the ref must point to a `.md` file
 *   - `hooks`: the ref (if a string) must point to a `.json` file
 *   - `commands`: the ref can be a file or directory; existence is sufficient
 */
function validateManifestFileRefs(pluginDir: string, pluginName: string): Finding[] {
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch {
    return [
      hardFinding(
        pluginName,
        `.claude-plugin/plugin.json is not valid JSON`,
        `fix the JSON syntax in ${manifestPath}`,
      ),
    ];
  }

  const parseResult = claudePluginManifestSchema.safeParse(raw);
  if (!parseResult.success) {
    // Shape errors (including a missing required field, e.g. `name`) — surface a hard finding
    // here. Skip ref checking: there is no reliably-shaped manifest data to check refs against.
    const issues = parseResult.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return [
      hardFinding(
        pluginName,
        `.claude-plugin/plugin.json failed schema validation: ${issues}`,
        'Verify the manifest fields match the claude plugin manifest schema.',
      ),
    ];
  }

  const manifest = parseResult.data;
  const findings: Finding[] = [];

  // skills: directory path(s)
  for (const ref of normalizePathField(manifest.skills)) {
    const finding = checkRef(pluginDir, pluginName, 'skills', ref, 'directory');
    if (finding !== null) findings.push(finding);
  }

  // agents: .md file path(s)
  for (const ref of normalizePathField(manifest.agents)) {
    const finding = checkRef(pluginDir, pluginName, 'agents', ref, 'md-file');
    if (finding !== null) findings.push(finding);
  }

  // commands: path string(s) — file or directory, just check existence
  for (const ref of normalizePathField(manifest.commands)) {
    const finding = checkRef(pluginDir, pluginName, 'commands', ref, 'any');
    if (finding !== null) findings.push(finding);
  }

  // hooks: path string → .json file (inline objects have no path to check)
  if (typeof manifest.hooks === 'string') {
    const finding = checkRef(pluginDir, pluginName, 'hooks', manifest.hooks, 'json-file');
    if (finding !== null) findings.push(finding);
  }

  // mcpServers: a config-path string is NOT existence-checked (it names a `.mcp.json` config, not a
  // component tree), but a `..` parent-traversal in it must still be rejected hard (spec §7 item 1).
  const mcpTraversal = rejectPathTraversal(pluginName, 'mcpServers', manifest.mcpServers);
  if (mcpTraversal !== null) findings.push(mcpTraversal);

  return findings;
}

/**
 * Reject (HARD `schema-invalid`) a `..` parent-traversal segment in a string config-path field that
 * is not covered by {@link checkRef}'s existence-based validation (e.g. `mcpServers`). Returns
 * `null` for non-string values (inline records) and traversal-free paths.
 */
function rejectPathTraversal(pluginName: string, field: string, value: unknown): Finding | null {
  if (typeof value === 'string' && hasTraversalSegment(value)) {
    return hardFinding(
      pluginName,
      `.claude-plugin/plugin.json ${field} path must not contain "..": ${value}`,
      `remove parent-directory traversal segments from the path`,
    );
  }
  return null;
}

type RefKind = 'directory' | 'md-file' | 'json-file' | 'any';

function checkRef(
  pluginDir: string,
  pluginName: string,
  field: string,
  ref: string,
  kind: RefKind,
): Finding | null {
  // Schema already enforces `./` prefix and `.md`/`.json` suffixes, but we
  // re-check gracefully so the validator is robust against schema bypass.
  if (!ref.startsWith('./')) {
    return hardFinding(
      pluginName,
      `.claude-plugin/plugin.json ${field} path must start with "./": ${ref}`,
      `change the path to start with "./"`,
    );
  }

  if (hasTraversalSegment(ref)) {
    return hardFinding(
      pluginName,
      `.claude-plugin/plugin.json ${field} path must not contain "..": ${ref}`,
      `remove parent-directory traversal segments from the path`,
    );
  }

  const normalized = ref.slice(2); // strip leading "./"
  const resolved = path.join(pluginDir, normalized);

  if (!fs.existsSync(resolved)) {
    const hint = buildMissingHint(pluginName, field, ref);
    return hardFinding(
      pluginName,
      `.claude-plugin/plugin.json ${field} references non-existent path: ${ref}`,
      hint,
    );
  }

  const stat = fs.statSync(resolved);

  if (kind === 'directory' && !stat.isDirectory()) {
    return hardFinding(
      pluginName,
      `.claude-plugin/plugin.json ${field} path must be a directory, but is a file: ${ref}`,
      `create a directory at ${ref} or remove the reference from plugin.json`,
    );
  }

  if (kind === 'md-file') {
    if (!stat.isFile()) {
      return hardFinding(
        pluginName,
        `.claude-plugin/plugin.json ${field} path must be a .md file: ${ref}`,
        `create an agent .md file at ${ref}`,
      );
    }
    if (!ref.endsWith('.md')) {
      return hardFinding(
        pluginName,
        `.claude-plugin/plugin.json ${field} path must end with ".md": ${ref}`,
        `rename the file to end with ".md"`,
      );
    }
  }

  if (kind === 'json-file') {
    if (!stat.isFile()) {
      return hardFinding(
        pluginName,
        `.claude-plugin/plugin.json ${field} path must be a .json file: ${ref}`,
        `create the hooks JSON file at ${ref}`,
      );
    }
    if (!ref.endsWith('.json')) {
      return hardFinding(
        pluginName,
        `.claude-plugin/plugin.json ${field} path must end with ".json": ${ref}`,
        `rename the file to end with ".json"`,
      );
    }
  }

  return null;
}

function buildMissingHint(pluginName: string, field: string, ref: string): string {
  const relPath = ref.slice(2); // strip "./"
  if (field === 'agents') {
    return `create plugins/${pluginName}/${relPath} or remove the reference from plugin.json`;
  }
  if (field === 'skills') {
    return `create a directory at plugins/${pluginName}/${relPath} or remove the reference from plugin.json`;
  }
  if (field === 'hooks') {
    return `run \`aipm build\` to generate the hooks JSON, or remove the reference from plugin.json`;
  }
  return `create plugins/${pluginName}/${relPath} or remove the reference from plugin.json`;
}

// ---------------------------------------------------------------------------
// Agent frontmatter validation
// ---------------------------------------------------------------------------

/**
 * Validate YAML frontmatter of all `.md` files directly under `agents/` (one level deep).
 * Each file must have a frontmatter block and it must satisfy `claudeAgentFrontmatterSchema`.
 */
function validateAgentFrontmatter(pluginDir: string, pluginName: string): Finding[] {
  const agentsDir = path.join(pluginDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const findings: Finding[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const agentPath = path.join(agentsDir, entry.name);
    const relPath = `agents/${entry.name}`;
    const content = fs.readFileSync(agentPath, 'utf-8');

    // Require a frontmatter block: must start with "---\n" and have a closing "---"
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
    if (fmMatch === null) {
      findings.push(
        hardFinding(
          pluginName,
          `${relPath}: agent .md has no frontmatter block`,
          `add a YAML frontmatter block between --- markers at the top of ${relPath}`,
        ),
      );
      continue;
    }

    const frontmatterYaml = fmMatch[1] ?? '';
    let parsed: unknown;
    try {
      parsed = parseYaml(frontmatterYaml);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push(
        hardFinding(
          pluginName,
          `${relPath}: frontmatter YAML parse error: ${msg}`,
          `fix the YAML syntax in the frontmatter of ${relPath}`,
        ),
      );
      continue;
    }

    const result = claudeAgentFrontmatterSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      findings.push(
        hardFinding(
          pluginName,
          `${relPath}: frontmatter does not match schema — ${issues}`,
          `ensure ${relPath} frontmatter includes required fields: name, description`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Hooks file validation
// ---------------------------------------------------------------------------

/**
 * If `hooks/claude.json` exists, validate it parses as JSON and matches
 * `claudeHooksFileSchema`. Missing file → no finding (the file is optional).
 */
function validateHooksFile(pluginDir: string, pluginName: string): Finding[] {
  const hooksPath = path.join(pluginDir, 'hooks', 'claude.json');
  if (!fs.existsSync(hooksPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as unknown;
  } catch {
    return [
      hardFinding(
        pluginName,
        `hooks/claude.json is not valid JSON`,
        `fix the JSON syntax in hooks/claude.json or regenerate it with \`aipm build\``,
      ),
    ];
  }

  // `hooks/claude.json` is a toolkit-generated, JSON-field-sentinel carrier (§4.3): the build
  // writes a top-level `_generated` marker onto it. The hooks schema is `.strict()`, so we drop
  // that toolkit-owned key before schema validation — it is not part of the Claude hooks format.
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && '_generated' in raw) {
    const { _generated: _ignored, ...rest } = raw as Record<string, unknown>;
    raw = rest;
  }

  const result = claudeHooksFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      hardFinding(
        pluginName,
        `hooks/claude.json does not match the hooks schema — ${issues}`,
        `check that hooks use only known event names (PreToolUse, PostToolUse, Stop, UserPromptSubmit) and regenerate with \`aipm build\``,
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Auto-loaded hooks/hooks.json duplicate-reference validation
// ---------------------------------------------------------------------------

/**
 * The plugin-relative path Claude Code loads automatically, in POSIX form.
 *
 * Claude Code auto-loads `<pluginDir>/hooks/hooks.json` when the file is present; a manifest
 * `hooks` reference to that same file is a *duplicate* registration and Claude Code hard-errors
 * ("Duplicate hooks file detected … The standard hooks/hooks.json is loaded automatically, so
 * manifest.hooks should only reference additional hook files").
 *
 * @see https://code.claude.com/docs/en/plugins-reference — Hooks component location:
 * "`hooks/hooks.json` in plugin root, or inline in plugin.json"; the manifest `hooks` field
 * names *additional* hook config paths (`"./my-extra-hooks.json"`).
 */
const CLAUDE_AUTOLOADED_HOOKS_PATH = 'hooks/hooks.json';

/**
 * Normalize a manifest path ref for comparison against a plugin-relative POSIX path:
 * backslashes → `/`, collapse `.` segments and duplicate separators, strip a leading `./`.
 * Returns `null` for a ref that escapes the plugin dir (`../…`), which is rejected elsewhere.
 */
function toPluginRelativePosix(ref: string): string | null {
  const normalized = path.posix.normalize(ref.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '');
}

/**
 * Reject a manifest `hooks` reference that resolves to the plugin's auto-loaded
 * `hooks/hooks.json`.
 *
 * This is not a filesystem-existence problem (that is {@link checkRef}'s job) — it is a
 * *duplicate registration*: Claude Code loads `hooks/hooks.json` on its own, so naming it in the
 * manifest makes the host refuse to load the plugin. In this toolkit `hooks/hooks.json` is the
 * shared Codex/Gemini artifact and `hooks/claude.json` is Claude's, so a manifest pointing at
 * `hooks/hooks.json` is always wrong for the Claude target.
 *
 * Reads the manifest JSON directly rather than the schema-parsed value so an array-valued `hooks`
 * field — legal in Claude Code, not modeled by `claudePluginManifestSchema` — is still caught.
 */
function validateHooksAutoloadDuplicate(pluginDir: string, pluginName: string): Finding[] {
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch {
    // Malformed JSON is reported by validateManifestFileRefs.
    return [];
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const hooksField = (raw as Record<string, unknown>)['hooks'];

  const refs: string[] = [];
  if (typeof hooksField === 'string') {
    refs.push(hooksField);
  } else if (Array.isArray(hooksField)) {
    refs.push(...hooksField.filter((v): v is string => typeof v === 'string'));
  }

  const findings: Finding[] = [];
  for (const ref of refs) {
    if (toPluginRelativePosix(ref) !== CLAUDE_AUTOLOADED_HOOKS_PATH) continue;
    findings.push(
      hardFinding(
        pluginName,
        `.claude-plugin/plugin.json hooks references ${ref}: Claude Code auto-loads ${CLAUDE_AUTOLOADED_HOOKS_PATH} and errors on a duplicate manifest reference`,
        `remove the ${ref} entry from the manifest hooks field (drop the field entirely if it names nothing else) — ${CLAUDE_AUTOLOADED_HOOKS_PATH} is loaded automatically. Claude's own hooks artifact is ./hooks/claude.json; the manifest hooks field may only name additional hook files.`,
      ),
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run all Claude-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * Returns zero or more Findings. Callers combine these with other targets'
 * findings and the cross-target findings in the pipeline validator.
 *
 * All findings emitted here use `plugin: path.basename(pluginDir)`.
 */
export function validateClaudePlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);

  return [
    ...validateManifestFileRefs(pluginDir, pluginName),
    ...validateAgentFrontmatter(pluginDir, pluginName),
    ...validateHooksFile(pluginDir, pluginName),
    ...validateHooksAutoloadDuplicate(pluginDir, pluginName),
    ...validateOpenPluginsConformance(pluginDir, pluginName),
  ];
}

/**
 * SOFT Open Plugins conformance advisories for a Claude plugin (spec §7 / OP-D10): name-grammar
 * drift and vendor metadata-dir isolation. These never fail the plugin — they only surface what
 * Open Plugins would additionally want.
 *
 * The name-grammar advisory fires only for a NATIVE-VALID manifest: a name that is invalid for
 * Claude already draws a hard finding, so the soft advisory is reserved for genuine drift (a name
 * Claude accepts but Open Plugins rejects, e.g. `a--b`). The metadata-dir advisory is filesystem-
 * only, independent of manifest validity.
 */
function validateOpenPluginsConformance(pluginDir: string, pluginName: string): Finding[] {
  const vendorDir = '.claude-plugin';
  const findings: Finding[] = [];

  const manifestPath = path.join(pluginDir, vendorDir, 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = claudePluginManifestSchema.safeParse(raw);
      if (parsed.success) {
        findings.push(
          ...nameGrammarConformanceFindings(
            pluginName,
            `${vendorDir}/plugin.json`,
            parsed.data.name,
          ),
        );
      }
    } catch {
      // Malformed JSON is reported by the hard validators; no advisory here.
    }
  }

  findings.push(...metadataDirConformanceFindings(pluginDir, vendorDir, pluginName));
  return findings;
}
