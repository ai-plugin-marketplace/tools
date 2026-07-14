/**
 * Per-target validator for the OpenAI Codex CLI target.
 *
 * Responsibilities (v0.1.0):
 *   1. Manifest file refs resolve — checks that paths in .codex-plugin/plugin.json exist on disk
 *      with the correct type (directory for skills, .md for agents, either for commands). Hooks
 *      and apps refs are intentionally excluded: Codex hook/app generation is out of scope for
 *      v0.1.0, so those paths are not guaranteed to exist in a Codex-only build context.
 *
 * Cross-target concerns (envelope adherence, name consistency, MCP key sync, marketplace
 * registration, freshness) are NOT checked here.
 *
 * @see https://developers.openai.com/codex/plugins/build
 * @see packages/core/docs/specs/architecture.md §10 (validation contract)
 * @see packages/core/docs/specs/architecture.md §8.1 (Finding, FindingCode)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Finding } from '../../pipeline/types.js';
import {
  metadataDirConformanceFindings,
  nameGrammarConformanceFindings,
} from '../open-plugins-conformance.js';
import { hasTraversalSegment } from '../path-safety.js';
import { codexPluginManifestSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvalid(plugin: string, message: string, hint?: string): Finding {
  const finding: Finding = { severity: 'hard', code: 'schema-invalid', plugin, message };
  if (hint !== undefined) finding.hint = hint;
  return finding;
}

/**
 * Normalise a manifest field that may be a single string path, an array of string paths, or an
 * inline object (which has no resolvable paths). Returns only the string path entries.
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
  const manifestPath = path.join(pluginDir, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [
      makeInvalid(
        pluginName,
        `.codex-plugin/plugin.json is not valid JSON`,
        'Ensure the file is well-formed JSON.',
      ),
    ];
  }

  const parsed = codexPluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join('; ');
    return [
      makeInvalid(
        pluginName,
        `.codex-plugin/plugin.json failed schema validation: ${issues}`,
        'Verify the manifest fields match the codex plugin manifest schema.',
      ),
    ];
  }

  const manifest = parsed.data;
  const findings: Finding[] = [];

  // Ref groups: skills → directory, agents → .md file, commands → either.
  // hooks/apps are intentionally excluded — Codex hook/app generation is out of scope for
  // v0.1.0, so those paths are not guaranteed present in a Codex-only build context.
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
            `.codex-plugin/plugin.json: ${field} path must start with "./": ${refPath}`,
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
            `.codex-plugin/plugin.json: ${field} path must not contain "..": ${refPath}`,
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
            `.codex-plugin/plugin.json: ${field} references non-existent path: ${refPath}`,
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
            `.codex-plugin/plugin.json: ${field} path must be a directory, but a file was found: ${refPath}`,
            `The ${field} field expects a directory path, not a file path.`,
          ),
        );
      } else if (mustBeDir === false && !stat.isFile()) {
        findings.push(
          makeInvalid(
            pluginName,
            `.codex-plugin/plugin.json: ${field} path must be a file, but a directory was found: ${refPath}`,
            `The ${field} field expects a file path, not a directory path.`,
          ),
        );
      }
    }
  }

  // hooks/mcpServers/apps config-path strings are NOT existence-checked (Codex hook/app generation
  // is out of scope for v0.1.0, and mcpServers names a shared `.mcp.json`), but a `..` parent-
  // traversal in them must still be rejected hard (spec §7 item 1).
  for (const field of ['hooks', 'mcpServers', 'apps'] as const) {
    const value = manifest[field];
    if (typeof value === 'string' && hasTraversalSegment(value)) {
      findings.push(
        makeInvalid(
          pluginName,
          `.codex-plugin/plugin.json: ${field} path must not contain "..": ${value}`,
          'Use a path relative to the plugin root without ".." traversal.',
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
 * Run all Codex-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory.
 * All findings use `plugin: path.basename(pluginDir)`.
 */
export function validateCodexPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);
  return [
    ...validateManifestFileRefs(pluginDir, pluginName),
    ...validateOpenPluginsConformance(pluginDir, pluginName),
  ];
}

/**
 * SOFT Open Plugins conformance advisories for a Codex plugin (spec §7 / OP-D10): name-grammar
 * drift and vendor metadata-dir isolation. Never fails the plugin.
 *
 * The name-grammar advisory fires only for a NATIVE-VALID manifest (a Codex-invalid name already
 * draws a hard finding); the metadata-dir advisory is filesystem-only.
 */
function validateOpenPluginsConformance(pluginDir: string, pluginName: string): Finding[] {
  const vendorDir = '.codex-plugin';
  const findings: Finding[] = [];

  const manifestPath = path.join(pluginDir, vendorDir, 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = codexPluginManifestSchema.safeParse(raw);
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
      // Malformed JSON is reported by validateManifestFileRefs; no advisory here.
    }
  }

  findings.push(...metadataDirConformanceFindings(pluginDir, vendorDir, pluginName));
  return findings;
}
