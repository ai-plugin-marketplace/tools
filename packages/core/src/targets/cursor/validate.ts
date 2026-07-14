/**
 * Per-target validator for the Cursor target.
 *
 * Responsibilities (v0.1.0):
 *   1. Manifest file refs resolve — checks that paths in .cursor-plugin/plugin.json
 *      exist on disk with the correct type (directory for skills, .md for agents,
 *      either for commands). Hooks refs are intentionally excluded: the hooks field
 *      should point at `./hooks/cursor.json`, a toolkit-generated Cursor-format artifact
 *      that is not guaranteed to exist in a Cursor-only build context.
 *   2. Cursor rule frontmatter — validates YAML frontmatter in rules/*.mdc files
 *      against cursorRuleFrontmatterSchema. Files with no frontmatter block are
 *      silently skipped.
 *   3. Generated hooks file — when hooks/cursor.json is present, validates it against
 *      cursorHooksFileSchema (HARD schema-invalid on failure).
 *
 * Cross-target concerns (envelope adherence, name consistency, MCP key sync,
 * marketplace registration, freshness) are NOT checked here.
 *
 * @see packages/core/docs/specs/architecture.md §10 (validation contract)
 * @see packages/core/docs/specs/architecture.md §8.1 (Finding, FindingCode)
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
  cursorHooksFileSchema,
  cursorPluginManifestSchema,
  cursorRuleFrontmatterSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvalid(plugin: string, message: string, hint?: string): Finding {
  const finding: Finding = { severity: 'hard', code: 'schema-invalid', plugin, message };
  if (hint !== undefined) finding.hint = hint;
  return finding;
}

/**
 * Normalise a manifest field that may be a single string path, an array of
 * string paths, or an inline object (which has no resolvable paths). Returns
 * only the string path entries.
 */
function normalisePathField(
  value: string | string[] | Record<string, unknown> | undefined,
): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  // Inline object (record of commands, inline hooks object) — no paths to check.
  return [];
}

// ---------------------------------------------------------------------------
// Manifest file-ref validation
// ---------------------------------------------------------------------------

function validateManifestFileRefs(pluginDir: string, pluginName: string): Finding[] {
  const manifestPath = path.join(pluginDir, '.cursor-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [
      makeInvalid(
        pluginName,
        `.cursor-plugin/plugin.json is not valid JSON`,
        'Ensure the file is well-formed JSON.',
      ),
    ];
  }

  const parsed = cursorPluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join('; ');
    return [
      makeInvalid(
        pluginName,
        `.cursor-plugin/plugin.json failed schema validation: ${issues}`,
        'Verify the manifest fields match the cursor plugin manifest schema.',
      ),
    ];
  }

  const manifest = parsed.data;
  const findings: Finding[] = [];

  // Ref groups: skills → directory, agents → .md file, commands → either.
  // hooks is intentionally excluded — the hooks field should point at ./hooks/cursor.json,
  // a toolkit-generated artifact not guaranteed present in a Cursor-only build context.
  const refGroups: { field: string; paths: string[]; mustBeDir?: boolean }[] = [
    { field: 'skills', paths: normalisePathField(manifest.skills), mustBeDir: true },
    { field: 'agents', paths: normalisePathField(manifest.agents), mustBeDir: false },
    { field: 'commands', paths: normalisePathField(manifest.commands) },
  ];

  for (const { field, paths: refPaths, mustBeDir } of refGroups) {
    for (const refPath of refPaths) {
      // All manifest paths must start with "./"
      if (!refPath.startsWith('./')) {
        findings.push(
          makeInvalid(
            pluginName,
            `.cursor-plugin/plugin.json: ${field} path must start with "./": ${refPath}`,
            `Change the path to start with "./" (e.g. "./${refPath.replace(/^\/+/, '')}").`,
          ),
        );
        continue;
      }

      // Paths must not contain ".." segments (path traversal guard)
      if (hasTraversalSegment(refPath)) {
        findings.push(
          makeInvalid(
            pluginName,
            `.cursor-plugin/plugin.json: ${field} path must not contain "..": ${refPath}`,
            'Use a path relative to the plugin root without ".." traversal.',
          ),
        );
        continue;
      }

      const resolved = path.join(pluginDir, refPath.slice(2));

      if (!fs.existsSync(resolved)) {
        findings.push(
          makeInvalid(
            pluginName,
            `.cursor-plugin/plugin.json: ${field} references non-existent path: ${refPath}`,
            `Create the missing ${field === 'skills' ? 'directory' : 'file'} at ${resolved}.`,
          ),
        );
        continue;
      }

      const stat = fs.statSync(resolved);

      if (mustBeDir === true && !stat.isDirectory()) {
        findings.push(
          makeInvalid(
            pluginName,
            `.cursor-plugin/plugin.json: ${field} path must be a directory, but a file was found: ${refPath}`,
            `The ${field} field expects a directory path, not a file path.`,
          ),
        );
      } else if (mustBeDir === false && !stat.isFile()) {
        findings.push(
          makeInvalid(
            pluginName,
            `.cursor-plugin/plugin.json: ${field} path must be a file, but a directory was found: ${refPath}`,
            `The ${field} field expects a file path, not a directory path.`,
          ),
        );
      }
    }
  }

  // hooks/mcpServers config-path strings are NOT existence-checked (they name a config file, not a
  // component tree), but a `..` parent-traversal in them must still be rejected hard (spec §7 item 1).
  for (const field of ['hooks', 'mcpServers'] as const) {
    const finding = rejectPathTraversal(pluginName, field, manifest[field]);
    if (finding !== null) findings.push(finding);
  }

  return findings;
}

/**
 * Reject (HARD `schema-invalid`) a `..` parent-traversal segment in a string config-path field not
 * covered by the existence-based ref checks above. Returns `null` for non-string values (inline
 * records) and traversal-free paths.
 */
function rejectPathTraversal(pluginName: string, field: string, value: unknown): Finding | null {
  if (typeof value === 'string' && hasTraversalSegment(value)) {
    return makeInvalid(
      pluginName,
      `.cursor-plugin/plugin.json: ${field} path must not contain "..": ${value}`,
      'Use a path relative to the plugin root without ".." traversal.',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generated hooks-file validation (hooks/cursor.json)
// ---------------------------------------------------------------------------

/**
 * Validate the toolkit-generated `hooks/cursor.json` (when present) against
 * {@link cursorHooksFileSchema}. Emits a HARD `schema-invalid` finding on malformed JSON or a
 * schema mismatch; absent file → no finding (it need not exist in a Cursor-only build context).
 *
 * The toolkit stamps a top-level `_generated` sentinel onto the file (§4.3); it is a
 * toolkit-owned field, so it is dropped before the strict schema check rather than rejected.
 */
function validateCursorHooksFile(pluginDir: string, pluginName: string): Finding[] {
  const hooksPath = path.join(pluginDir, 'hooks', 'cursor.json');
  if (!fs.existsSync(hooksPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
  } catch {
    return [
      makeInvalid(
        pluginName,
        `hooks/cursor.json is not valid JSON`,
        'Ensure the file is well-formed JSON, or re-run `aipm build` to regenerate it.',
      ),
    ];
  }

  // Drop the toolkit-owned `_generated` sentinel (§4.3) so the strict schema validates only the
  // hook payload rather than rejecting the sentinel field.
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    delete (raw as Record<string, unknown>)['_generated'];
  }

  const parsed = cursorHooksFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return [
      makeInvalid(
        pluginName,
        `hooks/cursor.json failed schema validation: ${issues}`,
        'Regenerate the file with `aipm build`; do not hand-edit generated hook JSON.',
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Cursor rule frontmatter validation
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter block from a .mdc file.
 *
 * Returns `null` when no frontmatter block is present (plain content is valid).
 * Returns the parsed object when a frontmatter block is found.
 * Throws if the YAML inside the block is malformed.
 */
function parseMdcFrontmatter(content: string): Record<string, unknown> | null {
  // Frontmatter is strictly between a leading `---\n` and the next `---`
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;

  const yamlText = content.slice(4, end);
  // yaml.parse returns `unknown`; we cast to a loose record type so Zod can
  // validate the actual field types downstream.
  const parsed = parseYaml(yamlText) as unknown;
  // An empty frontmatter block parses to null/undefined — treat as no frontmatter.
  if (parsed === null || parsed === undefined) return null;
  return parsed as Record<string, unknown>;
}

function validateCursorRules(pluginDir: string, pluginName: string): Finding[] {
  const rulesDir = path.join(pluginDir, 'rules');
  if (!fs.existsSync(rulesDir)) return [];

  const findings: Finding[] = [];

  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mdc')) continue;

    const filePath = path.join(rulesDir, entry.name);
    const content = fs.readFileSync(filePath, 'utf-8');

    let frontmatter: Record<string, unknown> | null;
    try {
      frontmatter = parseMdcFrontmatter(content);
    } catch {
      findings.push(
        makeInvalid(
          pluginName,
          `rules/${entry.name}: frontmatter YAML is malformed`,
          'Ensure the YAML between the --- delimiters is valid.',
        ),
      );
      continue;
    }

    // No frontmatter block → skip (plain .mdc content is valid)
    if (frontmatter === null) continue;

    const result = cursorRuleFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      findings.push(
        makeInvalid(
          pluginName,
          `rules/${entry.name}: frontmatter failed schema validation: ${issues}`,
          'Check the alwaysApply (boolean), globs (string[]), and description (string) fields.',
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all Cursor-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * All findings use `plugin: path.basename(pluginDir)`.
 */
export function validateCursorPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);
  return [
    ...validateManifestFileRefs(pluginDir, pluginName),
    ...validateCursorHooksFile(pluginDir, pluginName),
    ...validateCursorRules(pluginDir, pluginName),
    ...validateOpenPluginsConformance(pluginDir, pluginName),
  ];
}

/**
 * SOFT Open Plugins conformance advisories for a Cursor plugin (spec §7 / OP-D10): name-grammar
 * drift and vendor metadata-dir isolation. Never fails the plugin.
 *
 * The name-grammar advisory fires only for a NATIVE-VALID manifest (a Cursor-invalid name already
 * draws a hard finding); the metadata-dir advisory is filesystem-only.
 */
function validateOpenPluginsConformance(pluginDir: string, pluginName: string): Finding[] {
  const vendorDir = '.cursor-plugin';
  const findings: Finding[] = [];

  const manifestPath = path.join(pluginDir, vendorDir, 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = cursorPluginManifestSchema.safeParse(raw);
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
      // Malformed JSON is handled by the hard validators; no advisory here.
    }
  }

  findings.push(...metadataDirConformanceFindings(pluginDir, vendorDir, pluginName));
  return findings;
}
