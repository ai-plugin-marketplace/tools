/**
 * Pipeline orchestration for scaffolding and compatibility-assist (§6.4).
 *
 * Three orchestrators perform filesystem I/O around the per-target *pure* scaffold functions:
 *
 *   - `runScaffold`     — create a brand-new plugin (the `aipm scaffold` surface).
 *   - `runAddTarget`    — add one target's skeleton to an existing plugin (`aipm add-target`).
 *   - `runCheckSupport` — report declared-but-incomplete and plausibly-addable targets
 *                          (`aipm check-support`).
 *
 * Per §3.4/§12.4 the pipeline layer is the orchestration boundary and MAY import each target's
 * `scaffold.ts`; the per-target scaffold modules themselves never import one another.
 *
 * Envelope reading (§6.1): loading and executing a TypeScript `aipm.config.ts` from disk is the
 * build orchestrator's job and is not yet built. `runCheckSupport`/`runAddTarget` therefore read
 * the declared targets *pragmatically* — by extracting the `targets: [...]` array literal out of
 * the config source text (see `parseDeclaredTargets`). This tolerates the canonical
 * `defineConfig({ ... })` form this module emits and common hand-authored variants, but it is a
 * lexical heuristic, not a TS evaluation. Documented limitation: a config that computes `targets`
 * dynamically (spread, variable reference, conditional) is not understood and yields an error.
 *
 * @see docs/specs/architecture.md §6 (support envelope)
 * @see docs/specs/architecture.md §6.4 (compatibility-assist tooling)
 * @see docs/specs/architecture.md §10.1 (validation contract — artifact tables reused here)
 * @see docs/specs/architecture.md §12.5 (per-target scaffold.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { scaffoldClaudeFiles } from '../targets/claude/scaffold.js';
import { scaffoldCodexFiles } from '../targets/codex/scaffold.js';
import { scaffoldCursorFiles } from '../targets/cursor/scaffold.js';
import { scaffoldGeminiFiles } from '../targets/gemini/scaffold.js';
import { scaffoldKiroFiles } from '../targets/kiro/scaffold.js';
import { scaffoldVercelFiles } from '../targets/vercel/scaffold.js';
import type { ScaffoldedFile, TargetScaffoldOptions } from '../targets/scaffold-kit.js';
import { SCHEMA_VERSION } from '../targets/scaffold-kit.js';
import { TARGET_IDS } from './types.js';
import type { ScaffoldOptions, SupportReport, TargetId } from './types.js';
import { TARGET_MIN_REQUIRED } from './validate.js';

// ---------------------------------------------------------------------------
// Per-target scaffold dispatch
// ---------------------------------------------------------------------------

/** Map a target ID to its pure scaffold function. */
const TARGET_SCAFFOLDERS: Record<
  TargetId,
  (pluginName: string, opts?: TargetScaffoldOptions) => ScaffoldedFile[]
> = {
  claude: scaffoldClaudeFiles,
  codex: scaffoldCodexFiles,
  cursor: scaffoldCursorFiles,
  gemini: scaffoldGeminiFiles,
  kiro: scaffoldKiroFiles,
  vercel: scaffoldVercelFiles,
};

const md = String.raw;
const ts = String.raw;

// ---------------------------------------------------------------------------
// Name validation (mirrors the slug rules enforced by the manifest schemas)
// ---------------------------------------------------------------------------

/**
 * Validate a plugin name against the canonical slug rules shared by every manifest schema:
 * lowercase, starts with a letter, `[a-z0-9-]` only, no consecutive hyphens, no trailing hyphen.
 *
 * @throws Error with a clear message when the name is invalid.
 */
export function validatePluginName(name: string): void {
  if (name === '') {
    throw new Error('Plugin name is required.');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Invalid plugin name: "${name}". Names must be lowercase, start with a letter, and contain only letters, digits, and hyphens.`,
    );
  }
  if (name.includes('--')) {
    throw new Error(`Invalid plugin name: "${name}". Names must not contain consecutive hyphens.`);
  }
  if (name.endsWith('-')) {
    throw new Error(`Invalid plugin name: "${name}". Names must not end with a hyphen.`);
  }
}

// ---------------------------------------------------------------------------
// aipm.config.ts generation + parsing
// ---------------------------------------------------------------------------

/**
 * Render the canonical `aipm.config.ts` source for a plugin with the given targets.
 *
 * Emits a `defineConfig({ version, targets })` literal importing from the public package root
 * (§8.1 — the only public subpath). Deterministic: stable target ordering, no timestamps.
 */
export function renderAipmConfig(targets: readonly TargetId[]): string {
  const ordered = orderTargets(targets);
  const targetList = ordered.map((t) => `'${t}'`).join(', ');
  return ts`import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '${SCHEMA_VERSION}',
  targets: [${targetList}],
});
`;
}

/**
 * Extract the declared targets from `aipm.config.ts` source text.
 *
 * Lexical heuristic (see module doc): finds the first `targets:` key and parses the immediately
 * following `[...]` array of single/double-quoted string literals. Only IDs in `TARGET_IDS` are
 * returned; unknown IDs are ignored (the shape validator surfaces those separately).
 *
 * @returns Declared target IDs in canonical order, deduplicated.
 * @throws Error when no `targets: [...]` array literal can be located.
 */
export function parseDeclaredTargets(configSource: string): TargetId[] {
  // Match `targets` followed by optional whitespace, a colon, then a bracketed list.
  const match = /targets\s*:\s*\[([^\]]*)\]/.exec(configSource);
  if (!match) {
    throw new Error(
      'Could not locate a `targets: [...]` array literal in aipm.config.ts. ' +
        'Dynamically-computed targets are not supported by the lexical envelope reader.',
    );
  }
  const inner = match[1] ?? '';
  const ids = [...inner.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
  const known = new Set<string>(TARGET_IDS);
  const declared = ids.filter((id): id is TargetId => known.has(id));
  return orderTargets([...new Set(declared)]);
}

/** Order a target set by the canonical `TARGET_IDS` ordering. Deterministic output. */
function orderTargets(targets: readonly TargetId[]): TargetId[] {
  const present = new Set(targets);
  return TARGET_IDS.filter((t) => present.has(t));
}

// ---------------------------------------------------------------------------
// Marketplace registration (§4.4, §10.1.4)
// ---------------------------------------------------------------------------

/** A plugin entry in a string-source registry (Claude/Cursor): `{ name, source: string }`. */
interface StringSourceEntry {
  name: string;
  source: string;
}

/**
 * A plugin entry in the Codex object-source registry: `{ name, source: { source, path }, … }`
 * with `policy`/`category` defaults. Matches the shape at
 * developers.openai.com/codex/plugins/build.
 */
interface CodexEntry {
  name: string;
  source: { source: string; path: string };
  policy: { installation: string; authentication: string };
  category: string;
}

/** A descriptor for a registry-backed target: where its marketplace lives and how to build an entry. */
interface MarketplaceRegistryDescriptor {
  target: TargetId;
  /** Path segments under the repo root locating this registry's marketplace.json. */
  marketplaceRel: string[];
  /** Build the plugin entry to append, given the plugin name and its repo-relative `source`. */
  makeEntry: (pluginName: string, source: string) => StringSourceEntry | CodexEntry;
}

/**
 * The canonical `source` value for a plugin's registry entry: the plugin directory's path
 * relative to the repo root, `./`-prefixed and POSIX-separated (§4.4). For the default topology
 * this is `./plugins/<name>`; for an embedded marketplace with a relocated `pluginsRoot` it is
 * e.g. `./agent-plugins/<name>`. Hosts resolve `source` relative to the repo root, and this must
 * match what `validateMarketplaceRegistration` expects (it computes the same relative path).
 */
function marketplaceSource(repoRoot: string, pluginDir: string): string {
  return `./${path.relative(repoRoot, pluginDir).split(path.sep).join('/')}`;
}

/**
 * The template-level marketplace registries a plugin must be registered in, keyed by the target
 * whose presence in the envelope requires registration (§4.4). All registries live at the **repo
 * root**, not inside any plugin. Claude/Cursor use a string `source`; Codex uses an object
 * `source` plus `policy`/`category` defaults at `.agents/plugins/marketplace.json`.
 *
 * Mirrors `validateMarketplaceRegistration` in `validate.ts`: same targets, same paths, same
 * entry shapes.
 *
 * @see https://developers.openai.com/codex/plugins/build
 */
const MARKETPLACE_REGISTRIES: MarketplaceRegistryDescriptor[] = [
  {
    target: 'claude',
    marketplaceRel: ['.claude-plugin', 'marketplace.json'],
    makeEntry: (name, source) => ({ name, source }),
  },
  {
    target: 'cursor',
    marketplaceRel: ['.cursor-plugin', 'marketplace.json'],
    makeEntry: (name, source) => ({ name, source }),
  },
  {
    target: 'codex',
    marketplaceRel: ['.agents', 'plugins', 'marketplace.json'],
    makeEntry: (name, source) => ({
      name,
      source: { source: 'local', path: source },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }),
  },
];

/** Minimal shape of a marketplace registry file. Extra keys are preserved on rewrite. */
interface MarketplaceRegistry {
  plugins?: { name: string }[];
  [key: string]: unknown;
}

/**
 * Register `pluginName` in the registry file at `registryPath`, creating it if absent. The entry
 * shape is supplied by the caller (string-source for Claude/Cursor, object-source for Codex).
 *
 * Idempotent: if an entry whose `name` already matches `pluginName` exists, the file is left
 * untouched (no duplicate, no source rewrite — repairing a wrong source is the validator's job to
 * report, not the scaffolder's to silently mutate). Output is 2-space JSON with a trailing newline.
 *
 * Existing entries and any extra top-level keys are preserved.
 */
function registerInMarketplace(
  registryPath: string,
  pluginName: string,
  entry: StringSourceEntry | CodexEntry,
): void {
  let registry: MarketplaceRegistry;
  if (fs.existsSync(registryPath)) {
    const raw: unknown = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    // Tolerate a missing/!object/!plugins file by normalizing to a registry with a plugins array.
    registry =
      typeof raw === 'object' && raw !== null ? (raw as MarketplaceRegistry) : { plugins: [] };
  } else {
    registry = { plugins: [] };
  }

  const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];
  if (plugins.some((p) => p.name === pluginName)) {
    return; // already registered — idempotent no-op
  }

  registry.plugins = [...plugins, entry];

  writeFileEnsuringDir(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * Register a plugin in every marketplace registry implied by its envelope (§4.4).
 *
 * For each registry-backed target present in `targets`, create-or-append the plugin's entry in
 * the corresponding `<repoRoot>/<marketplaceRel>`. Targets not in the envelope get no entry, so
 * the scaffold→validate happy path stays clean (the validator forbids registration for
 * undeclared targets).
 */
function registerPluginInMarketplaces(
  repoRoot: string,
  pluginDir: string,
  targets: readonly TargetId[],
): void {
  const pluginName = path.basename(pluginDir);
  const source = marketplaceSource(repoRoot, pluginDir);
  const envelope = new Set(targets);
  for (const { target, marketplaceRel, makeEntry } of MARKETPLACE_REGISTRIES) {
    if (!envelope.has(target)) continue;
    registerInMarketplace(
      path.join(repoRoot, ...marketplaceRel),
      pluginName,
      makeEntry(pluginName, source),
    );
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Write `content` to `filePath`, creating parent directories. Does not check for existence. */
function writeFileEnsuringDir(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Canonical top-level files every scaffolded plugin gets, independent of targets (§4 layout).
 * Deterministic: no clock/env reads — the LICENSE year is intentionally omitted.
 */
function canonicalRootFiles(pluginName: string, description: string): ScaffoldedFile[] {
  const readme = md`# ${pluginName}

${description}

## Installation

Install this plugin by copying it into your AI assistant's plugin directory.

## License

ISC
`;

  const license = `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

  return [
    { path: 'README.md', content: readme },
    { path: 'LICENSE', content: license },
  ];
}

// ---------------------------------------------------------------------------
// runScaffold
// ---------------------------------------------------------------------------

/**
 * Create a brand-new plugin under `pluginsDir/<name>/`.
 *
 * Writes `aipm.config.ts` (via the `defineConfig` literal), each declared target's skeleton
 * files, and the canonical `README.md` / `LICENSE`. Default targets are all known IDs when
 * `opts.targets` is absent.
 *
 * Also registers the plugin in the template-level marketplace registries (§4.4) for each of
 * Claude/Cursor in the envelope (`repoRoot = dirname(pluginsDir)`), so the scaffolded plugin
 * passes `validate`'s `marketplace-registration` check (§10.1.4) out of the box.
 *
 * @throws Error when `name` is invalid or the plugin directory already exists.
 */
export async function runScaffold(
  name: string,
  pluginsDir: string,
  opts: ScaffoldOptions = {},
): Promise<void> {
  validatePluginName(name);

  const pluginDir = path.join(pluginsDir, name);
  if (fs.existsSync(pluginDir)) {
    throw new Error(`Plugin directory already exists: ${pluginDir}`);
  }

  const targets = orderTargets(opts.targets ?? TARGET_IDS);
  const description = opts.description ?? `A plugin for ${name}`;
  const targetOpts: TargetScaffoldOptions = { description };

  const files: ScaffoldedFile[] = [
    { path: 'aipm.config.ts', content: renderAipmConfig(targets) },
    ...canonicalRootFiles(name, description),
  ];

  for (const target of targets) {
    files.push(...TARGET_SCAFFOLDERS[target](name, targetOpts));
  }

  fs.mkdirSync(pluginDir, { recursive: true });
  for (const file of files) {
    writeFileEnsuringDir(path.join(pluginDir, file.path), file.content);
  }

  // Register in the repo-root marketplace registries (§4.4). repoRoot is the parent of pluginsDir,
  // so a relocated `pluginsRoot` yields a matching repo-relative `source` (e.g. ./agent-plugins/x).
  registerPluginInMarketplaces(path.dirname(pluginsDir), pluginDir, targets);

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// runAddTarget
// ---------------------------------------------------------------------------

/**
 * Scaffold one target's skeleton files into an existing plugin (§6.4 `aipm add-target`).
 *
 * Manifest fields are emitted as placeholders for the author to complete. Existing files are
 * NEVER clobbered: if any file this target would write already exists, the function refuses and
 * throws — the author resolves the conflict deliberately.
 *
 * The plugin's `aipm.config.ts` is updated to include `target` in its `targets` array when the
 * lexical reader can locate the array (see module doc). Limitation: if the array cannot be parsed
 * (dynamic/computed targets), the config is left untouched and the error message instructs the
 * author to add the target manually — the function never leaves the envelope silently
 * inconsistent.
 *
 * When `target` is Claude or Cursor, the plugin is also registered in the corresponding
 * repo-root marketplace registry (§4.4) so adding the target keeps `validate` green. repoRoot is
 * the plugin's grandparent (`<repoRoot>/plugins/<name>`), matching `discoverPlugins`.
 *
 * @throws Error when `pluginDir` does not exist, a target file already exists, or the config's
 * targets array cannot be located for the update.
 */
export async function runAddTarget(pluginDir: string, target: TargetId): Promise<void> {
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin directory does not exist: ${pluginDir}`);
  }

  const pluginName = path.basename(pluginDir);
  const files = TARGET_SCAFFOLDERS[target](pluginName, { placeholder: true });

  // Refuse to overwrite: collect conflicts before writing anything.
  const conflicts = files
    .map((f) => f.path)
    .filter((rel) => fs.existsSync(path.join(pluginDir, rel)));
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files while adding target '${target}': ${conflicts.join(', ')}. ` +
        'Remove or move them first, then re-run.',
    );
  }

  // Update the envelope BEFORE writing skeleton files, so a config we cannot parse aborts the
  // whole operation rather than leaving orphan files with an unchanged envelope.
  updateConfigTargets(pluginDir, target);

  for (const file of files) {
    writeFileEnsuringDir(path.join(pluginDir, file.path), file.content);
  }

  // Register in the repo-root marketplace registry when adding a registry-backed target (§4.4).
  // repoRoot = dirname(dirname(pluginDir)) — the `<repoRoot>/<pluginsRoot>/<name>` grandparent.
  registerPluginInMarketplaces(path.dirname(path.dirname(pluginDir)), pluginDir, [target]);

  return Promise.resolve();
}

/**
 * Add `target` to the `targets` array in `pluginDir/aipm.config.ts`, rewriting the file.
 *
 * Idempotent: if `target` is already declared, the file is left byte-for-byte unchanged.
 * Always re-renders the array in canonical order. Throws (rather than silently skipping) when the
 * config is missing or the array cannot be located, so the caller never proceeds with an
 * inconsistent envelope.
 */
function updateConfigTargets(pluginDir: string, target: TargetId): void {
  const configPath = path.join(pluginDir, 'aipm.config.ts');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Cannot add target '${target}': no aipm.config.ts found at ${configPath}. ` +
        'Create one declaring the support envelope first.',
    );
  }

  const source = fs.readFileSync(configPath, 'utf-8');
  const declared = parseDeclaredTargets(source); // throws if no array literal located
  if (declared.includes(target)) {
    return; // already declared — nothing to do
  }

  const next = orderTargets([...declared, target]);
  const targetList = next.map((t) => `'${t}'`).join(', ');
  const rewritten = source.replace(/targets\s*:\s*\[[^\]]*\]/, `targets: [${targetList}]`);
  fs.writeFileSync(configPath, rewritten, 'utf-8');
}

// ---------------------------------------------------------------------------
// runCheckSupport
// ---------------------------------------------------------------------------

/**
 * Report a plugin's support posture (§6.4 `aipm check-support`).
 *
 * Reads the declared envelope from `aipm.config.ts` (lexically — see module doc), then:
 *   - `missingArtifacts`: for each declared target, the `TARGET_MIN_REQUIRED` files absent on disk
 *     (Vercel's "at least one SKILL.md under a skills subdirectory" rule is applied specially,
 *     mirroring the
 *     validator). Only targets with at least one missing artifact appear.
 *   - `suggestions`: each undeclared known target, with `wouldNeed` = that target's min-required
 *     files (the concrete list of files the author would write to add it).
 *
 * Reuses the validator's `TARGET_MIN_REQUIRED` table so "missing" stays consistent with
 * `aipm validate`.
 *
 * @throws Error when `pluginDir` or its `aipm.config.ts` is missing, or the envelope is unreadable.
 */
export async function runCheckSupport(pluginDir: string): Promise<SupportReport> {
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin directory does not exist: ${pluginDir}`);
  }
  const configPath = path.join(pluginDir, 'aipm.config.ts');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No aipm.config.ts found at ${configPath}.`);
  }

  const source = fs.readFileSync(configPath, 'utf-8');
  const declared = parseDeclaredTargets(source);
  const declaredSet = new Set(declared);

  const missingArtifacts: SupportReport['missingArtifacts'] = [];
  for (const target of declared) {
    const missing = missingMinRequired(pluginDir, target);
    if (missing.length > 0) {
      missingArtifacts.push({ target, missing });
    }
  }

  const suggestions: SupportReport['suggestions'] = TARGET_IDS.filter(
    (t) => !declaredSet.has(t),
  ).map((target) => ({ target, wouldNeed: wouldNeedArtifacts(target) }));

  return Promise.resolve({
    plugin: path.basename(pluginDir),
    declared,
    missingArtifacts,
    suggestions,
  });
}

/**
 * The min-required artifacts for `target` that are absent under `pluginDir`.
 *
 * Vercel has no entry in `TARGET_MIN_REQUIRED` (its requirement is "at least one
 * a SKILL.md under a skills subdirectory", a directory-scan rule), so it is handled specially to
 * match the validator.
 */
function missingMinRequired(pluginDir: string, target: TargetId): string[] {
  if (target === 'vercel') {
    return hasAnyVercelSkill(pluginDir) ? [] : ['skills/<skill-name>/SKILL.md'];
  }
  return TARGET_MIN_REQUIRED[target].filter((rel) => !fs.existsSync(path.join(pluginDir, rel)));
}

/** The concrete files an author would write to add `target` (mirrors `missingMinRequired`). */
function wouldNeedArtifacts(target: TargetId): string[] {
  if (target === 'vercel') {
    return ['skills/<skill-name>/SKILL.md'];
  }
  return [...TARGET_MIN_REQUIRED[target]];
}

/** True iff at least one `skills/<dir>/SKILL.md` exists one level under `pluginDir/skills`. */
function hasAnyVercelSkill(pluginDir: string): boolean {
  const skillsDir = path.join(pluginDir, 'skills');
  if (!fs.existsSync(skillsDir)) return false;
  try {
    for (const dirent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && fs.existsSync(path.join(skillsDir, dirent.name, 'SKILL.md'))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
