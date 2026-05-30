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
