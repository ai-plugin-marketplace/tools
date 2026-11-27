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
 * @see docs/specs/architecture.md §10.1.5 (Claude hooks live in `hooks/hooks.json`)
 * @see docs/specs/architecture.md §12.5 (internal module shape)
 */

import {
  collectReadableChecks,
  isFileEntry,
  referenceExists,
  repositoryFs as fs,
} from '../../pipeline/repository-fs.js';
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
import { isToolkitSentinelFor, sidecarPath } from '../../pipeline/sentinel.js';
import { CLAUDE_HOOKS_FILENAME, CLAUDE_HOOKS_SOURCES } from './transform.js';

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

  if (
    !referenceExists(
      resolved,
      kind === 'directory' ? 'directory' : kind === 'any' ? undefined : 'file',
    )
  ) {
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
    if (!isFileEntry(agentsDir, entry, '.md')) continue;

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

/** Plugin-relative POSIX path of the hooks file Claude Code loads on its own. */
const CLAUDE_HOOKS_PATH = `hooks/${CLAUDE_HOOKS_FILENAME}`;

/**
 * Plugin-relative POSIX path of the retired Claude hooks artifact. Earlier toolkit versions wrote
 * Claude's hooks here and wired them in through the manifest `hooks` field.
 */
const RETIRED_CLAUDE_HOOKS_PATH = 'hooks/claude.json';

/**
 * Top-level keys a Claude `hooks/hooks.json` may carry. The Claude desktop app leaves the whole
 * `hooks/` folder out of its remote (SSH) plugin sync when the file has any other key, so a plugin
 * that works locally would silently lose its hooks on remote hosts.
 */
const CLAUDE_HOOKS_FILE_KEYS: ReadonlySet<string> = new Set(['$schema', 'description', 'hooks']);

/** Whether the hooks file at `hooksPath` has a `.generated` sidecar this toolkit wrote. */
function hasToolkitSidecar(hooksPath: string): boolean {
  const sidecar = sidecarPath(hooksPath);
  return (
    isRegularFile(sidecar) &&
    isToolkitSentinelFor(fs.readFileSync(sidecar, 'utf-8'), 'sidecar', CLAUDE_HOOKS_SOURCES)
  );
}

/** Whether `absPath` is a regular file (not missing, a directory, or another kind of entry). */
function isRegularFile(absPath: string): boolean {
  return fs.statSync(absPath, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * If `hooks/hooks.json` exists, validate it parses as JSON and carries only the keys Claude hosts
 * accept. Missing file → no finding (the file is optional).
 *
 * Claude Code auto-loads this file whoever wrote it, so the JSON and key checks apply to a
 * hand-written one too, along with the object shape Claude Code reads. Only a toolkit-generated
 * file (its `.generated` sidecar carries this toolkit's sentinel) is checked
 * against `claudeHooksFileSchema`: that schema is the YAML compiler's source contract, which is
 * narrower than the events and handler forms Claude Code accepts in a hand-written file.
 */
function validateHooksFile(pluginDir: string, pluginName: string): Finding[] {
  const hooksPath = path.join(pluginDir, ...CLAUDE_HOOKS_PATH.split('/'));
  if (!fs.existsSync(hooksPath)) return [];
  if (!isRegularFile(hooksPath)) {
    return [
      hardFinding(
        pluginName,
        `${CLAUDE_HOOKS_PATH} is not a regular file`,
        `replace ${CLAUDE_HOOKS_PATH} with a JSON file, or remove it`,
      ),
    ];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as unknown;
  } catch {
    return [
      hardFinding(
        pluginName,
        `${CLAUDE_HOOKS_PATH} is not valid JSON`,
        `fix the JSON syntax in ${CLAUDE_HOOKS_PATH} or regenerate it with \`aipm build\``,
      ),
    ];
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [
      hardFinding(
        pluginName,
        `${CLAUDE_HOOKS_PATH} must be a JSON object with a hooks field`,
        `wrap the hooks in { "hooks": { ... } } or regenerate ${CLAUDE_HOOKS_PATH} with \`aipm build\``,
      ),
    ];
  }
  const extra = Object.keys(raw).filter((k) => !CLAUDE_HOOKS_FILE_KEYS.has(k));
  if (extra.length > 0) {
    return [
      hardFinding(
        pluginName,
        `${CLAUDE_HOOKS_PATH} has top-level key(s) ${extra.join(', ')}: the Claude desktop app drops hooks from its remote plugin sync unless the file has only $schema, description and hooks`,
        `remove ${extra.join(', ')} from ${CLAUDE_HOOKS_PATH}, or regenerate it with \`aipm build\` (generated files keep their marker in ${CLAUDE_HOOKS_PATH}.generated)`,
      ),
    ];
  }
  // Claude Code reads `hooks` as an object mapping each event to an array of matcher groups, each
  // an object with a `hooks` array of handlers. Event names and handler forms are left to the host.
  const hooks = (raw as Record<string, unknown>)['hooks'];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  // Every handler names its `type`; a command handler also needs the `command` it runs.
  const isHandler = (h: unknown): boolean =>
    isObject(h) &&
    typeof h['type'] === 'string' &&
    (h['type'] !== 'command' || typeof h['command'] === 'string');
  const isMatcherGroup = (g: unknown): boolean =>
    isObject(g) && Array.isArray(g['hooks']) && g['hooks'].every(isHandler);
  const badEvents = isObject(hooks)
    ? Object.entries(hooks)
        .filter(([, groups]) => !Array.isArray(groups) || !groups.every(isMatcherGroup))
        .map(([event]) => event)
    : undefined;
  if (badEvents === undefined || badEvents.length > 0) {
    return [
      hardFinding(
        pluginName,
        badEvents === undefined
          ? `${CLAUDE_HOOKS_PATH} has no hooks object`
          : `${CLAUDE_HOOKS_PATH} event(s) ${badEvents.join(', ')} must each hold an array of matcher groups, each with a hooks array of handlers that have a type (and a command, for command handlers)`,
        `give ${CLAUDE_HOOKS_PATH} the shape { "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }, or regenerate it with \`aipm build\``,
      ),
    ];
  }
  // `description` is accepted by Claude hosts but is not part of the hooks schema proper.
  const { description: _description, $schema: _schema, ...rest } = raw as Record<string, unknown>;

  if (!hasToolkitSidecar(hooksPath)) return [];

  const result = claudeHooksFileSchema.safeParse(rest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return [
      hardFinding(
        pluginName,
        `${CLAUDE_HOOKS_PATH} does not match the hooks schema — ${issues}`,
        `check that hooks use only known event names (PreToolUse, PostToolUse, Stop, UserPromptSubmit) and regenerate with \`aipm build\``,
      ),
    ];
  }

  return [];
}

/**
 * Flag a generated `hooks/hooks.json` whose source `hooks/claude.yaml` is gone. Claude Code would
 * keep loading hooks the author deleted, and freshness cannot see it because no source produces
 * the file any more.
 */
function validateOrphanedHooksFile(pluginDir: string, pluginName: string): Finding[] {
  if (!hasToolkitSidecar(path.join(pluginDir, ...CLAUDE_HOOKS_PATH.split('/')))) return [];
  const hasSource = ['claude.yaml', 'claude.yml'].some((name) =>
    fs.existsSync(path.join(pluginDir, 'hooks', name)),
  );
  if (hasSource) return [];
  return [
    hardFinding(
      pluginName,
      `${CLAUDE_HOOKS_PATH} was generated from hooks/claude.yaml, which no longer exists, so Claude Code still loads the deleted hooks`,
      `restore hooks/claude.yaml and run \`aipm build\`; if these hooks are no longer wanted, delete ${CLAUDE_HOOKS_PATH} and ${CLAUDE_HOOKS_PATH}.generated`,
    ),
  ];
}

/**
 * Flag a leftover `hooks/claude.json` from an earlier toolkit version. Nothing loads it any more,
 * so keeping it only invites a manifest reference that would break remote sync.
 */
function validateRetiredHooksFile(pluginDir: string, pluginName: string): Finding[] {
  if (!fs.existsSync(path.join(pluginDir, ...RETIRED_CLAUDE_HOOKS_PATH.split('/')))) return [];
  return [
    hardFinding(
      pluginName,
      `${RETIRED_CLAUDE_HOOKS_PATH} is no longer generated or loaded; Claude's hooks now live in ${CLAUDE_HOOKS_PATH}`,
      `run \`aipm build\` to write ${CLAUDE_HOOKS_PATH} from hooks/claude.yaml (port the hooks there first if it is missing); point a Cursor manifest that names ${RETIRED_CLAUDE_HOOKS_PATH} at ./hooks/cursor.json and a Codex manifest at ./${CLAUDE_HOOKS_PATH}; then delete ${RETIRED_CLAUDE_HOOKS_PATH}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Manifest hooks field validation
// ---------------------------------------------------------------------------

/**
 * Reject any `hooks` field in `.claude-plugin/plugin.json`, whether a path, an array of paths, or
 * an inline object (including one under `experimental`).
 *
 * Two host behaviors make the field wrong for toolkit plugins:
 *
 * - Claude Code auto-loads `hooks/hooks.json`, and naming that file in the manifest is a duplicate
 *   registration that makes it refuse the plugin ("Duplicate hooks file detected").
 * - The Claude desktop app refuses to sync a plugin to remote (SSH) hosts when its manifest has a
 *   `hooks` field at all ("refusing plugin that relocates hooks via manifest"), so the plugin is
 *   missing from every remote session.
 *
 * Reads the manifest JSON directly rather than the schema-parsed value so an array-valued or
 * inline `hooks` field, legal in Claude Code but not modeled by `claudePluginManifestSchema`, is
 * still caught.
 *
 * @see https://code.claude.com/docs/en/plugins-reference
 */
function validateManifestHooksField(pluginDir: string, pluginName: string): Finding[] {
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
  const manifest = raw as Record<string, unknown>;
  const experimental = manifest['experimental'];
  const inExperimental =
    typeof experimental === 'object' &&
    experimental !== null &&
    !Array.isArray(experimental) &&
    'hooks' in experimental;
  if (!('hooks' in manifest) && !inExperimental) return [];

  const field = inExperimental && !('hooks' in manifest) ? 'experimental.hooks' : 'hooks';
  return [
    hardFinding(
      pluginName,
      `.claude-plugin/plugin.json has a ${field} field: Claude Code loads ${CLAUDE_HOOKS_PATH} on its own, and the Claude desktop app will not sync a plugin whose manifest names hooks to remote (SSH) hosts`,
      `remove the ${field} field from .claude-plugin/plugin.json; author hooks in hooks/claude.yaml and run \`aipm build\`, which writes ${CLAUDE_HOOKS_PATH}`,
    ),
  ];
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

  return collectReadableChecks([
    () => validateManifestFileRefs(pluginDir, pluginName),
    () => validateAgentFrontmatter(pluginDir, pluginName),
    () => validateHooksFile(pluginDir, pluginName),
    () => validateRetiredHooksFile(pluginDir, pluginName),
    () => validateOrphanedHooksFile(pluginDir, pluginName),
    () => validateManifestHooksField(pluginDir, pluginName),
    () => validateOpenPluginsConformance(pluginDir, pluginName),
  ]);
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
