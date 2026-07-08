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

/**
 * Resolve a manifest component path against the plugin root, returning `undefined` when the
 * resolved path would escape the plugin directory (spec §2.1: "A plugin MUST NOT reference files
 * outside its own directory"). Defense-in-depth: {@link openPluginsManifestSchema} already rejects
 * non-`./`, backslash, and `..`-segment paths, but this validator touches the filesystem with the
 * resolved path, so it independently confirms containment rather than trusting the schema layer
 * (the two are separately maintained). Lexical only — symlink escapes are a host-install concern,
 * not a manifest-shape concern.
 *
 * Exported for direct unit testing with hostile inputs the schema would normally reject.
 */
export function resolveContainedPath(pluginDir: string, refPath: string): string | undefined {
  if (refPath.includes('\\')) return undefined;
  const resolved = path.resolve(pluginDir, refPath);
  const root = path.resolve(pluginDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

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

  // Every declared component path must stay inside the plugin directory and resolve on disk.
  // Containment is re-verified here (not just trusted from the schema) because this is the layer
  // that touches the filesystem with the resolved path — see {@link resolveContainedPath}.
  for (const field of COMPONENT_FIELDS) {
    const refPaths = normalisePathField(manifest[field] as ComponentPathValue);
    for (const refPath of refPaths) {
      const resolved = resolveContainedPath(pluginDir, refPath);
      if (resolved === undefined) {
        findings.push(
          makeInvalid(
            pluginName,
            `.plugin/plugin.json: ${field} path escapes the plugin directory: ${refPath}`,
            'Component paths must be "./"-relative, POSIX-separated, and stay within the plugin root.',
          ),
        );
        continue;
      }
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

  // A readdir failure is itself a violation, not a pass: `.plugin` existing as a FILE (ENOTDIR)
  // means the metadata directory shape is wrong, and an unreadable directory cannot be shown to
  // satisfy the isolation rule — either way, report rather than silently skipping the check.
  let entries: string[];
  try {
    entries = fs.readdirSync(metaDir);
  } catch (err) {
    const isNotDir = (err as NodeJS.ErrnoException).code === 'ENOTDIR';
    return [
      {
        severity: 'hard',
        code: 'metadata-dir-isolation',
        plugin: pluginName,
        message: isNotDir
          ? `.plugin exists but is not a directory — the Open Plugins metadata directory must be a directory containing only plugin.json.`
          : `.plugin/ could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — its isolation cannot be verified.`,
        hint: isNotDir
          ? 'Replace the .plugin file with a .plugin/ directory holding plugin.json.'
          : 'Fix the directory permissions so .plugin/ is readable.',
      },
    ];
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
