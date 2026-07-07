/**
 * Per-target validator for the Open Plugins target.
 *
 * Responsibilities (v0.1.0):
 *   1. Manifest schema — parse `.plugin/plugin.json` and validate it against
 *      {@link openPluginsManifestSchema} (spec §2.1). Failures are hard `schema-invalid`.
 *   2. Manifest file refs resolve — every declared component path (`commands`/`agents`/`skills`/
 *      `rules`/`hooks`/`mcpServers`/`lspServers`/`outputStyles`) must exist on disk. A declared but
 *      missing path is hard `schema-invalid` (the manifest references a component tree that is not
 *      there).
 *   3. Metadata-dir isolation — the metadata directory `.plugin/` MUST contain ONLY `plugin.json`
 *      (spec §2.1). Any sibling entry is hard `metadata-dir-isolation`.
 *
 * Cross-target concerns (envelope adherence, name consistency, marketplace registration, freshness)
 * are NOT checked here — they live in the pipeline's cross-target validator.
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see docs/specs/architecture.md §10 (validation contract)
 * @see docs/specs/architecture.md §8.1 (Finding, FindingCode)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Finding } from '../../pipeline/types.js';
import { openPluginsManifestSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvalid(plugin: string, message: string, hint?: string): Finding {
  const finding: Finding = { severity: 'hard', code: 'schema-invalid', plugin, message };
  if (hint !== undefined) finding.hint = hint;
  return finding;
}

/**
 * A parsed component-path field value: a single path, an array of paths, or the
 * `{ paths, exclusive? }` object form. Normalised to the list of embedded string paths.
 */
type ComponentPathValue = string | string[] | { paths: string[]; exclusive?: boolean } | undefined;

/** Normalise a component-path field to its list of string paths (spec §2.1 accepts three forms). */
function normalisePathField(value: ComponentPathValue): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return value.paths;
}

/** The component-path fields the manifest may declare (spec §2.1), in a stable order. */
const COMPONENT_FIELDS = [
  'commands',
  'agents',
  'skills',
  'rules',
  'hooks',
  'mcpServers',
  'lspServers',
  'outputStyles',
] as const;

// ---------------------------------------------------------------------------
// Manifest schema + file-ref validation
// ---------------------------------------------------------------------------

function validateManifest(pluginDir: string, pluginName: string): Finding[] {
  const manifestPath = path.join(pluginDir, '.plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [
      makeInvalid(
        pluginName,
        `.plugin/plugin.json is not valid JSON`,
        'Ensure the file is well-formed JSON.',
      ),
    ];
  }

  const parsed = openPluginsManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join('; ');
    return [
      makeInvalid(
        pluginName,
        `.plugin/plugin.json failed schema validation: ${issues}`,
        'Verify the manifest fields match the Open Plugins manifest specification.',
      ),
    ];
  }

  const manifest = parsed.data;
  const findings: Finding[] = [];

  // Every declared component path must resolve on disk. The schema already guarantees each path is
  // `./`-relative with no `..`, so we only check existence here.
  for (const field of COMPONENT_FIELDS) {
    const refPaths = normalisePathField(manifest[field] as ComponentPathValue);
    for (const refPath of refPaths) {
      const resolved = path.join(pluginDir, refPath.slice(2));
      if (!fs.existsSync(resolved)) {
        findings.push(
          makeInvalid(
            pluginName,
            `.plugin/plugin.json: ${field} references non-existent path: ${refPath}`,
            `Create the missing component at ${resolved}, or remove the reference.`,
          ),
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Metadata-dir isolation (spec §2.1)
// ---------------------------------------------------------------------------

/**
 * The Open Plugins metadata directory `.plugin/` MUST contain only `plugin.json` (spec §2.1). Any
 * other entry (file or directory) is a hard `metadata-dir-isolation` finding. Scoped to `.plugin/`
 * specifically — the native vendor dirs (`.claude-plugin/`, `.cursor-plugin/`) are allowed to hold
 * a `marketplace.json`, so this check does not apply to them.
 */
function validateMetadataDirIsolation(pluginDir: string, pluginName: string): Finding[] {
  const metaDir = path.join(pluginDir, '.plugin');
  if (!fs.existsSync(metaDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(metaDir);
  } catch {
    return [];
  }

  const extras = entries.filter((e) => e !== 'plugin.json').sort();
  if (extras.length === 0) return [];

  return [
    {
      severity: 'hard',
      code: 'metadata-dir-isolation',
      plugin: pluginName,
      message: `.plugin/ must contain only plugin.json, but also contains: ${extras.join(', ')}.`,
      hint: 'Move these files out of .plugin/ — the Open Plugins metadata directory may hold only plugin.json.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all Open Plugins-specific validators against a plugin directory.
 *
 * `pluginDir` is the absolute path to a `plugins/<name>/` directory. All findings use
 * `plugin: path.basename(pluginDir)`.
 */
export function validateOpenPluginsPlugin(pluginDir: string): Finding[] {
  const pluginName = path.basename(pluginDir);
  return [
    ...validateManifest(pluginDir, pluginName),
    ...validateMetadataDirIsolation(pluginDir, pluginName),
  ];
}
