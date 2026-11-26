/**
 * Artifact generation shared by build and freshness validation (§10.5).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PAYLOAD_ADAPTER_FILENAME, PAYLOAD_ADAPTER_SOURCE } from '../hooks/payload-adapter.js';
import {
  CLAUDE_HOOKS_FILENAME,
  parseClaudeHooksYaml,
  serializeClaudeHooksJson,
} from '../targets/claude/transform.js';
import {
  convertClaudeHooksYamlToCursorJson,
  cursorDocHasGatingHook,
} from '../targets/cursor/transform.js';
import { CURSOR_SHIM_FILENAME, CURSOR_SHIM_RUNNER_SOURCE } from '../targets/cursor/shim-runner.js';
import { bundleGeminiPlugin } from '../targets/gemini/bundle.js';
import { bundleKiroPlugin } from '../targets/kiro/bundle.js';

import type { AipmWorkspace } from '../config.js';

import { getGeneratorVersion } from './generator-version.js';
import { loadPluginConfig, type ConfigCache } from './load-config.js';
import { applyJsonSentinel, sidecarContent, sidecarPath, type SentinelMode } from './sentinel.js';
import type { Finding, GeneratedFileTarget, TargetId } from './types.js';

/**
 * A toolkit-generated file that lives **inside the plugin directory** and carries a sentinel.
 * Both the build (which writes `expectedContent`) and the freshness check (which compares the
 * on-disk bytes against `expectedContent`) derive these from one place so they cannot diverge.
 */
export interface PluginHookArtifact {
  /** Absolute path of the generated file. */
  absPath: string;
  /** Author-authored source path, relative to the plugin dir (recorded in the sentinel). */
  source: string;
  /** Sentinel carrier used for this artifact. */
  sentinelMode: SentinelMode;
  /** Which target's build step produced this file, or `'shared'` — see {@link GeneratedFileTarget}. */
  target: GeneratedFileTarget;
  /** Exact bytes the build writes (sentinel included). */
  expectedContent: string;
  /**
   * When `true`, the build sets the executable bit (`0o755`) on the written file. Reserved for
   * assets meant to be invoked directly (e.g. `hooks/payload-adapter` — spec §1/§11 document
   * calling it as `"${CLAUDE_PLUGIN_ROOT}/hooks/payload-adapter"`), never its `.generated`
   * sidecar or JSON artifacts. Omitted (not `false`) when not executable.
   */
  executable?: true;
}

/** First existing hooks YAML candidate (`claude.yaml`, then `claude.yml`), or `undefined`. */
function findHooksYaml(
  pluginDir: string,
  exists: typeof fs.existsSync,
): { absPath: string; source: string } | undefined {
  for (const name of ['claude.yaml', 'claude.yml']) {
    const absPath = path.join(pluginDir, 'hooks', name);
    if (exists(absPath)) {
      return { absPath, source: `hooks/${name}` };
    }
  }
  return undefined;
}

/**
 * Compute every in-plugin-dir generated hook JSON for a plugin given its envelope, **without
 * writing**. This is the single source of truth shared by `runBuild` and the freshness check.
 *
 * - A hooks YAML present AND declaring at least one hook event (i.e. `hooks:` is non-empty) →
 *   `hooks/payload-adapter` (the static cross-harness `sh`+`jq` payload-normalization filter,
 *   sidecar-carried sentinel) and its `hooks/payload-adapter.generated` sidecar
 *   (docs/specs/payload-adapter.md §11, D10). Emission does not depend on which target(s) the
 *   envelope declares — the adapter is useful to any handler, gating or not — but it IS skipped
 *   for a hooks YAML whose `hooks:` map is empty (`{}`): nothing could ever invoke it, so emitting
 *   the adapter would be dead weight (issue #58, nit 1).
 * - `claude` in envelope + a hooks YAML present → `hooks/hooks.json` (Claude JSON, sentinel-free)
 *   and its `hooks/hooks.json.generated` sidecar. Claude Code auto-loads `hooks/hooks.json`, so the
 *   manifest names no hooks file; the Claude desktop app refuses to sync a plugin to remote (SSH)
 *   hosts when its manifest has a `hooks` field, and drops `hooks/hooks.json` from the sync when it
 *   has any top-level key besides `$schema`, `description` and `hooks`
 *   (docs/specs/hooks-json-autoload-collision.md, Option 4b).
 * - `gemini` emits no in-plugin hook file: Gemini is emitted-installed and reads the
 *   `dist/gemini/<plugin>/hooks/hooks.json` its bundler writes (same doc, Option 4a).
 * - `cursor` in envelope + a hooks YAML present → `hooks/cursor.json` (Cursor JSON + sentinel), plus
 *   — when ≥1 gating-event hook is present — the fail-closed shim runner `hooks/cursor-shim.mjs`
 *   (static JS, sidecar-carried sentinel) and its `hooks/cursor-shim.mjs.generated` sidecar
 *   (cursor-controller-shim.md §3.3/§3.4).
 *
 * The JSON sentinel is applied to the **parsed object** so the on-disk file carries a top-level
 * `_generated` field (§4.3), serialized 2-space + trailing newline. The `.mjs` runner and the
 * payload adapter are pure executable scripts and carry no inline sentinel — their companion
 * `.generated` sidecars do.
 *
 * The `version` parameter is the `@ai-plugin-marketplace/core` version stamped into every
 * sentinel-carrying artifact (§4.3.1); it defaults to the installed core version. Both `runBuild`
 * (writing) and the freshness check (comparing) derive artifacts here, so the stamp cannot drift.
 *
 * @throws {Error} If the hooks YAML is malformed or fails the Claude hooks schema.
 */
export function computePluginHookArtifacts(
  pluginDir: string,
  envelope: readonly TargetId[],
  version: string = getGeneratorVersion(),
  exists = fs.existsSync,
): PluginHookArtifact[] {
  const yaml = findHooksYaml(pluginDir, exists);
  if (!yaml) return [];

  const envelopeSet = new Set(envelope);
  const artifacts: PluginHookArtifact[] = [];
  const yamlContent = fs.readFileSync(yaml.absPath, 'utf-8');

  // Parsed+validated once, up front, regardless of envelope: `hooks/claude.yaml` is always
  // authored in the Claude Code dialect (this module's own doc), so this is the single source of
  // truth both for gating payload-adapter emission below (issue #58 nit 1) and, when 'claude' is
  // declared, for `hooks/hooks.json` — the YAML is never parsed twice.
  const parsed = parseClaudeHooksYaml(yamlContent);
  const hasHooks = Object.keys(parsed.hooks).length > 0;

  // Payload adapter (docs/specs/payload-adapter.md §11, D10): emitted whenever a plugin authors a
  // hooks YAML that declares at least one hook event, independent of the target envelope — any
  // handler, gating or not, benefits from the normalized cross-harness payload. A pure,
  // plugin-independent script, so it carries a sidecar sentinel (like the cursor shim) rather than
  // an inline one. No single target's build step owns it, so it is attributed to `'shared'` rather
  // than an arbitrary envelope member. Skipped entirely for a hooks YAML whose `hooks:` map is
  // empty (`{}`) — nothing could ever invoke it (issue #58, nit 1).
  if (hasHooks) {
    const payloadAdapterAbsPath = path.join(pluginDir, 'hooks', PAYLOAD_ADAPTER_FILENAME);
    artifacts.push({
      absPath: payloadAdapterAbsPath,
      source: yaml.source,
      sentinelMode: 'sidecar',
      target: 'shared',
      expectedContent: PAYLOAD_ADAPTER_SOURCE,
      // Spec §1/§11: the adapter is invoked directly (`"${CLAUDE_PLUGIN_ROOT}/hooks/payload-adapter"`),
      // so it needs the executable bit — unlike its `.generated` sidecar below, which is never run.
      executable: true,
    });
    artifacts.push({
      absPath: sidecarPath(payloadAdapterAbsPath),
      source: yaml.source,
      sentinelMode: 'sidecar',
      target: 'shared',
      expectedContent: sidecarContent(yaml.source, version),
    });
  }

  if (envelopeSet.has('claude')) {
    // Claude reads `hooks/hooks.json` with no manifest reference. The file holds only the parsed
    // hooks document; its sentinel lives in the sidecar, because the desktop app's remote plugin
    // sync drops a hooks.json that carries any other top-level key (such as `_generated`).
    const claudeHooksAbsPath = path.join(pluginDir, 'hooks', CLAUDE_HOOKS_FILENAME);
    // The sidecar goes first: if the build stops between the two writes, the sidecar still marks
    // the pair as toolkit-owned and the next build completes it.
    artifacts.push({
      absPath: sidecarPath(claudeHooksAbsPath),
      source: yaml.source,
      sentinelMode: 'sidecar',
      target: 'claude',
      expectedContent: sidecarContent(yaml.source, version),
    });
    artifacts.push({
      absPath: claudeHooksAbsPath,
      source: yaml.source,
      sentinelMode: 'sidecar',
      target: 'claude',
      // Only `hooks` is written: `schemaVersion` is a source-only key, and Claude hosts reject any
      // top-level key in this file beyond $schema, description and hooks.
      expectedContent: serializeClaudeHooksJson({ hooks: parsed.hooks }),
    });
  }

  if (envelopeSet.has('cursor')) {
    // The Cursor transform returns a serialized string; parse it back to an object so the
    // sentinel sits at the top level. applyJsonSentinel re-serializes 2-space + newline,
    // matching the transform's own format, so the body round-trips byte-for-byte.
    const cursorJson = convertClaudeHooksYamlToCursorJson(yamlContent);
    const cursorObj = JSON.parse(cursorJson) as unknown;
    // "Has a gating hook?" is derived from the just-parsed converted document (a non-empty gating
    // Cursor event key), so the source YAML is parsed exactly ONCE for Cursor — no redundant
    // re-parse (spec §3.3).
    const hasGatingHook = cursorDocHasGatingHook(cursorObj);
    artifacts.push({
      absPath: path.join(pluginDir, 'hooks', 'cursor.json'),
      source: yaml.source,
      sentinelMode: 'json-field',
      target: 'cursor',
      expectedContent: applyJsonSentinel(cursorObj, yaml.source, version),
    });

    // Controller-hook shim (cursor-controller-shim.md §3.3/§3.4): when ≥1 gating-event hook is
    // present, cursor.json's shimmed entries invoke `hooks/cursor-shim.mjs`, so emit that static
    // runner plus its `.generated` sidecar sentinel (the .mjs is pure executable JS — the strict
    // format can't host an inline sentinel, so the sidecar carrier holds it). Both are compared
    // byte-for-byte by the freshness check. No shim files when no gating-event hook exists.
    if (hasGatingHook) {
      const shimAbsPath = path.join(pluginDir, 'hooks', CURSOR_SHIM_FILENAME);
      artifacts.push({
        absPath: shimAbsPath,
        source: yaml.source,
        sentinelMode: 'sidecar',
        target: 'cursor',
        expectedContent: CURSOR_SHIM_RUNNER_SOURCE,
      });
      artifacts.push({
        absPath: sidecarPath(shimAbsPath),
        source: yaml.source,
        sentinelMode: 'sidecar',
        target: 'cursor',
        expectedContent: sidecarContent(yaml.source, version),
      });
    }
  }

  return artifacts;
}

/**
 * The set of `dist/**` bundle trees a plugin's envelope produces. Each entry names the absolute
 * destination directory and a `regenerate` closure that rebuilds the tree into an arbitrary
 * directory — used both to emit the real bundle (build) and to regenerate into a temp dir for
 * the byte-parity freshness compare (§10.5). Bundles are sentinel-less by design.
 */
export interface DistBundle {
  target: TargetId;
  /** Absolute destination directory under `dist/`. */
  destDir: string;
  /** Rebuild the bundle into `into` (clears `into` first, per the bundlers' contract). */
  regenerate: (into: string) => void;
}

/**
 * Compute the `dist/**` bundles a plugin's envelope produces, **without writing**. Shared by
 * build (calls `regenerate(destDir)`) and freshness (calls `regenerate(tempDir)` then compares).
 */
export function computeDistBundles(
  pluginDir: string,
  distDir: string,
  envelope: readonly TargetId[],
  exists = fs.existsSync,
): DistBundle[] {
  const pluginName = path.basename(pluginDir);
  const envelopeSet = new Set(envelope);
  const bundles: DistBundle[] = [];

  if (envelopeSet.has('gemini')) {
    bundles.push({
      target: 'gemini',
      destDir: path.join(distDir, 'gemini', pluginName),
      regenerate: (into) => {
        bundleGeminiPlugin(pluginDir, into, exists);
      },
    });
  }

  if (envelopeSet.has('kiro')) {
    bundles.push({
      target: 'kiro',
      destDir: path.join(distDir, 'kiro', pluginName),
      regenerate: (into) => {
        bundleKiroPlugin(pluginDir, into, exists);
      },
    });
  }

  return bundles;
}

// TODO(spec §4.3): sidecar sentinels for strict-schema dist artifacts (Gemini
// `gemini-extension.json`, Kiro `.kiro/agents/*.json`) are deferred to preserve dist byte-parity
// with the committed oracle. Adding them requires regenerating the oracle in the template repo.

// ---------------------------------------------------------------------------
// Marketplace registry generation (§4.4, design spec "Marketplace registries")
// ---------------------------------------------------------------------------

/**
 * One discovered plugin's contribution to registry generation. The repo-level
 * {@link computeRegistryArtifacts} step assembles these (loading each plugin's `aipm.config.ts`
 * for `description`/`keywords` and its envelope) so the registry generator never re-reads disk.
 */
export interface RegistryPluginInfo {
  /** Plugin directory basename (the registry entry `name`). */
  name: string;
  /**
   * The plugin directory relative to the repo root, `./`-prefixed and POSIX-separated (e.g.
   * `./plugins/<name>`). This is the registry entry's `source` (string for Claude/Cursor, the
   * `source.path` for Codex). Honors a relocated `pluginsRoot`.
   */
  source: string;
  /** The plugin's declared support envelope (`config.targets`). */
  envelope: readonly TargetId[];
  /** Optional one-line description from `aipm.config.ts`; maps to the entry `description`/`tags` host. */
  description?: string;
  /** Optional keywords from `aipm.config.ts`; maps to the entry `tags` (Claude/Cursor). */
  keywords?: readonly string[];
}

/**
 * A generated marketplace registry file. Like `dist/` bundles, registries are **sentinel-less**:
 * the host schemas are strict and there is no companion sidecar, so freshness is a whole-file
 * regenerate-and-byte-compare against `expectedContent`. Both `runBuild` (which writes the bytes)
 * and the freshness check (which compares disk to the bytes) derive these from one place.
 */
export interface RegistryArtifact {
  /** The registry-backed target this file serves. */
  target: TargetId;
  /** Absolute path of the registry file (always at the repo root). */
  absPath: string;
  /** Exact bytes the build writes (2-space JSON + trailing newline). */
  expectedContent: string;
}

/** The registry-backed targets, ordered. Open Plugins' registry lives at the **repo root** (spec
 *  §2.4 lookup position 1); the native targets' registries live in vendor subdirectories. */
const REGISTRY_TARGETS = ['claude', 'cursor', 'codex', 'open-plugins'] as const;
type RegistryTarget = (typeof REGISTRY_TARGETS)[number];

/** Where each registry-backed target's `marketplace.json` lives, relative to the repo root. */
const REGISTRY_REL_PATHS: Record<RegistryTarget, readonly string[]> = {
  claude: ['.claude-plugin', 'marketplace.json'],
  cursor: ['.cursor-plugin', 'marketplace.json'],
  codex: ['.agents', 'plugins', 'marketplace.json'],
  'open-plugins': ['marketplace.json'],
};

/**
 * Registry-backed targets whose `marketplace.json` sits at the **repo root** rather than in a
 * vendor subdirectory. A repo-root registry is a repo-root path the toolkit writes, so — unlike the
 * vendor-dir registries — it is collision-guarded via the generated-root sidecar (OP-D5, VT-4): a
 * pre-existing foreign root `marketplace.json` must never be overwritten or orphan-removed. Routing
 * these through {@link detectRootCollisions} / the sidecar (option (a)) unifies "repo-root files the
 * toolkit owns" under one tracked set.
 */
const ROOT_REGISTRY_TARGETS = ['open-plugins'] as const satisfies readonly RegistryTarget[];

/** Whether a registry-backed target's `marketplace.json` lives at the repo root (collision-guarded). */
export function isRootRegistryTarget(target: TargetId): boolean {
  return (ROOT_REGISTRY_TARGETS as readonly TargetId[]).includes(target);
}

/**
 * Absolute paths of every registry the toolkit MANAGES under a repo root (one per registry-backed
 * target), regardless of whether the current envelope produces it. Used to detect **orphaned**
 * registries — a committed `marketplace.json` for a target no longer declared by any plugin —
 * which `runBuild` removes and the validator flags as stale. Shared so build and validate agree
 * on exactly which files generation owns (and never touch anything else).
 *
 * NOTE: the repo-root registries ({@link ROOT_REGISTRY_TARGETS}) are included here for
 * identity/discovery uses, but their orphan removal and collision protection run through the
 * generated-root sidecar path, NOT the blanket vendor-registry orphan sweep — callers that
 * orphan-remove must skip {@link isRootRegistryTarget} paths.
 */
export function managedRegistryPaths(repoRoot: string): string[] {
  return Object.values(REGISTRY_REL_PATHS).map((rel) => path.join(repoRoot, ...rel));
}

/** Absolute paths of the vendor-subdirectory registries only (excludes repo-root registries). */
export function managedVendorRegistryPaths(repoRoot: string): string[] {
  return REGISTRY_TARGETS.filter((t) => !isRootRegistryTarget(t)).map((t) =>
    path.join(repoRoot, ...REGISTRY_REL_PATHS[t]),
  );
}

/** Default Codex plugin category when none is otherwise specified (design spec §"Codex"). */
const CODEX_DEFAULT_CATEGORY = 'Productivity';

/**
 * Serialize a registry object as 2-space JSON with a trailing newline — byte-stable with the
 * `registerInMarketplace`/dist serialization so freshness compares cleanly.
 */
function serializeRegistry(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Build a Claude/Cursor (string-source) registry object from the workspace metadata and the
 * plugins whose envelope includes `target`. Entry shape:
 * `{ name, source, description?, tags? }` — `description`/`tags` keys are omitted when absent
 * (never serialized as `undefined`).
 */
function buildStringSourceRegistry(
  workspace: AipmWorkspace,
  plugins: readonly RegistryPluginInfo[],
): Record<string, unknown> {
  const { marketplace } = workspace;
  const registry: Record<string, unknown> = { name: marketplace.name };
  if (marketplace.owner !== undefined) {
    registry['owner'] = marketplace.owner;
  }
  if (marketplace.description !== undefined) {
    registry['metadata'] = { description: marketplace.description };
  }
  registry['plugins'] = plugins.map((p) => {
    const entry: Record<string, unknown> = { name: p.name, source: p.source };
    if (p.description !== undefined) entry['description'] = p.description;
    if (p.keywords !== undefined) entry['tags'] = [...p.keywords];
    return entry;
  });
  return registry;
}

/**
 * Build the Codex (object-source) registry object. Entry shape:
 * `{ name, source: { source: 'local', path }, policy: { installation, authentication }, category }`.
 * `interface.displayName` defaults to `marketplace.name`; `category` defaults to
 * `'Productivity'` (design spec §"Codex").
 */
function buildCodexRegistry(
  workspace: AipmWorkspace,
  plugins: readonly RegistryPluginInfo[],
): Record<string, unknown> {
  const { marketplace } = workspace;
  return {
    name: marketplace.name,
    interface: { displayName: marketplace.name },
    plugins: plugins.map((p) => ({
      name: p.name,
      source: { source: 'local', path: p.source },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: CODEX_DEFAULT_CATEGORY,
    })),
  };
}

/**
 * Build the Open Plugins (string-source) repo-root registry object (spec §2.4). Entry shape:
 * `{ name, source, description?, keywords? }` — note the Open Plugins spec field is `keywords`, NOT
 * the Claude/Cursor `tags`. Carries the workspace `name` and optional `owner`; `metadata.pluginRoot`
 * stays at its default `"."` (omitted) because each entry's `source` is the full repo-root-relative
 * path (OP-D4).
 */
function buildOpenPluginsRegistry(
  workspace: AipmWorkspace,
  plugins: readonly RegistryPluginInfo[],
): Record<string, unknown> {
  const { marketplace } = workspace;
  const registry: Record<string, unknown> = { name: marketplace.name };
  if (marketplace.owner !== undefined) {
    registry['owner'] = marketplace.owner;
  }
  registry['plugins'] = plugins.map((p) => {
    const entry: Record<string, unknown> = { name: p.name, source: p.source };
    if (p.description !== undefined) entry['description'] = p.description;
    if (p.keywords !== undefined) entry['keywords'] = [...p.keywords];
    return entry;
  });
  return registry;
}

/**
 * Compute the generated marketplace registries for a repo, **without writing**. The single source
 * of truth shared by `runBuild` (which writes `expectedContent`) and the freshness check (which
 * compares the on-disk bytes against it).
 *
 * A registry file is produced for each registry-backed target (`claude` → `.claude-plugin/`,
 * `cursor` → `.cursor-plugin/`, `codex` → `.agents/plugins/`, `open-plugins` → repo-root
 * `marketplace.json`) that appears in **at least one** plugin's envelope. Each registry lists
 * exactly the plugins whose envelope includes that target, in the order given (callers pass plugins
 * sorted by discovery). Registries are sentinel-less.
 *
 * The repo-root Open Plugins registry is byte-computed here like any other, but its WRITING is
 * routed through the collision-guarded generated-root sidecar path (OP-D5/VT-4) by the callers.
 *
 * @param repoRoot - Absolute repo root (where the registries live).
 * @param plugins - Discovered plugins with name/source/envelope/description/keywords.
 * @param workspace - The validated `aipm.workspace.ts` metadata.
 */
export function computeRegistryArtifacts(
  repoRoot: string,
  plugins: readonly RegistryPluginInfo[],
  workspace: AipmWorkspace,
): RegistryArtifact[] {
  const artifacts: RegistryArtifact[] = [];

  for (const target of REGISTRY_TARGETS) {
    const members = plugins.filter((p) => p.envelope.includes(target));
    if (members.length === 0) continue; // no plugin declares this target → no registry file

    const obj =
      target === 'codex'
        ? buildCodexRegistry(workspace, members)
        : target === 'open-plugins'
          ? buildOpenPluginsRegistry(workspace, members)
          : buildStringSourceRegistry(workspace, members);

    artifacts.push({
      target,
      absPath: path.join(repoRoot, ...REGISTRY_REL_PATHS[target]),
      expectedContent: serializeRegistry(obj),
    });
  }

  return artifacts;
}

/**
 * Assemble the {@link RegistryPluginInfo} for every discovered plugin under `repoRoot`, loading
 * each plugin's `aipm.config.ts` for its envelope, description, and keywords. Shared by `runBuild`
 * and the freshness check so both feed `computeRegistryArtifacts` identical input.
 *
 * @param repoRoot - Absolute repo root (the base for the `./`-prefixed `source`).
 * @param pluginDirs - Absolute plugin directories (already discovery-sorted).
 */
export async function collectRegistryPlugins(
  repoRoot: string,
  pluginDirs: readonly string[],
  cache?: ConfigCache,
): Promise<RegistryPluginInfo[]> {
  const infos: RegistryPluginInfo[] = [];
  for (const pluginDir of pluginDirs) {
    const config = await loadPluginConfig(pluginDir, cache);
    const source = `./${path.relative(repoRoot, pluginDir).split(path.sep).join('/')}`;
    infos.push({
      name: path.basename(pluginDir),
      source,
      envelope: config.targets,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.keywords !== undefined ? { keywords: config.keywords } : {}),
    });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Single-artifact-host repo-root native emission (Gemini / Kiro)
// ---------------------------------------------------------------------------

/**
 * The hosts that have NO multi-plugin marketplace concept: each installs exactly ONE
 * extension/power per repo, read from the **repo root**. `gemini extensions install <git>` reads a
 * root `gemini-extension.json`; Kiro "Add from GitHub" reads a root `POWER.md`. Because the repo
 * root has a single slot per host, at most one plugin may declare each — see the N=1 gate below.
 */
const SINGLE_ARTIFACT_HOSTS = ['gemini', 'kiro'] as const satisfies readonly TargetId[];

/** A single-artifact host (`gemini` | `kiro`). */
type SingleArtifactHost = (typeof SINGLE_ARTIFACT_HOSTS)[number];

/** Repo-root-relative path of the sidecar that tracks the toolkit-generated root file set. */
const ROOT_MANIFEST_REL = ['.aipm', 'generated-root.json'] as const;

/** Absolute path of the generated-root sidecar manifest under `repoRoot`. */
export function rootManifestPath(repoRoot: string): string {
  return path.join(repoRoot, ...ROOT_MANIFEST_REL);
}

/**
 * Bundle each single-artifact host into a fresh temp dir, returning the per-host destination dir.
 * The bundlers `rmSync` their destDir (gemini/bundle.ts, kiro/bundle.ts), so they MUST be pointed
 * at a throwaway temp directory — never the repo root or any real dir. Mirrors the
 * `regenerate`/temp pattern used by {@link computeDistBundles}.
 */
function bundleRootHost(
  host: SingleArtifactHost,
  pluginDir: string,
  tempDir: string,
  exists: typeof fs.existsSync,
): void {
  if (host === 'gemini') {
    bundleGeminiPlugin(pluginDir, tempDir, exists);
  } else {
    bundleKiroPlugin(pluginDir, tempDir, exists);
  }
}

/**
 * A single repo-root file the toolkit generates. `relPath` is the path relative to the repo root
 * (POSIX-separated, the tracked-set form); `content` is the exact bytes. `owner` is the target the
 * file belongs to — a single-artifact host (`gemini`/`kiro`) or a repo-root registry target
 * (`open-plugins`). Collision suppression and sidecar attribution key on `owner`.
 */
interface RootArtifactFile {
  /** Repo-root-relative POSIX path (e.g. `gemini-extension.json`, `commands/foo.toml`, `marketplace.json`). */
  relPath: string;
  /** The target this file belongs to (a single-artifact host or a repo-root registry target). */
  owner: TargetId;
  /** Exact bytes to write at the repo root. */
  content: Buffer;
}

/**
 * Result of {@link computeRootArtifacts}: the repo-root files to emit (across all single-artifact
 * hosts that passed the N=1 gate), the set of repo-root-relative paths generation owns, and any
 * `single-artifact-host` findings for hosts that more than one plugin declared (whose root artifact
 * is suppressed).
 */
export interface RootArtifacts {
  /** Files to write at the repo root (empty if no host is emittable). */
  files: RootArtifactFile[];
  /** Repo-root-relative POSIX paths the toolkit generated this run (the tracked set). Sorted. */
  trackedPaths: string[];
  /** Hard `single-artifact-host` findings — one per host declared by more than one plugin. */
  findings: Finding[];
}

/**
 * Derive the repo-root registry files ({@link ROOT_REGISTRY_TARGETS}) from already-computed registry
 * artifacts, as {@link RootArtifactFile}s. These flow through the same collision-guarded sidecar
 * path as the single-artifact-host root files (OP-D5/VT-4), so a pre-existing foreign root
 * `marketplace.json` raises `root-artifact-collision` and is never overwritten or orphan-removed.
 */
export function rootRegistryArtifactFiles(
  repoRoot: string,
  registries: readonly RegistryArtifact[],
): RootArtifactFile[] {
  return registries
    .filter((r) => isRootRegistryTarget(r.target))
    .map((r) => ({
      relPath: path.relative(repoRoot, r.absPath).split(path.sep).join('/'),
      owner: r.target,
      content: Buffer.from(r.expectedContent, 'utf-8'),
    }));
}

/**
 * Merge the single-artifact-host root artifacts with the repo-root registry files into one
 * {@link RootArtifacts}, so a single collision guard / sidecar tracked-set / orphan sweep covers
 * every repo-root file the toolkit owns (OP-D5/VT-4, option (a)).
 */
export function mergeRootArtifacts(
  base: RootArtifacts,
  registryFiles: readonly RootArtifactFile[],
): RootArtifacts {
  const files = [...base.files, ...registryFiles];
  const trackedPaths = [
    ...new Set([...base.trackedPaths, ...registryFiles.map((f) => f.relPath)]),
  ].sort();
  return { files, trackedPaths, findings: base.findings };
}

/**
 * Build a hard `single-artifact-host` finding. Repo-scoped (no owning plugin): the ambiguity is a
 * property of the whole repo's plugin set, not any one plugin.
 */
function singleArtifactHostFinding(
  host: SingleArtifactHost,
  declarers: readonly string[],
): Finding {
  const list = [...declarers].sort().join(', ');
  return {
    severity: 'hard',
    code: 'single-artifact-host',
    message:
      `Host '${host}' installs ONE extension/power per repo from the repo root, but ${String(declarers.length)} plugins declare it: [${list}]. ` +
      `Its root artifact is NOT emitted while this ambiguity stands.`,
    hint: `Remove '${host}' from all but one plugin's targets in aipm.config.ts so a single plugin owns the repo-root ${host} artifact.`,
  };
}

/**
 * Compute the repo-root native artifacts for the single-artifact hosts (`gemini`, `kiro`),
 * **without writing**. The single source of truth shared by `runBuild` (which writes the files,
 * applies the collision guard, and orphan-removes) and the freshness check (which compares disk to
 * these bytes). Bundling happens into a throwaway temp dir — the repo root is never passed to a
 * bundler, so the bundlers' `rmSync(destDir)` can never touch repo-root state.
 *
 * **N=1 gate (`single-artifact-host`).** For each host, count the plugins whose envelope declares
 * it. Exactly one declarer → emit that plugin's bundled files at the repo root. More than one →
 * emit a hard `single-artifact-host` finding and emit NOTHING for that host (the toolkit can't pick
 * which plugin owns the single root slot). Zero → nothing to emit (and no finding). The two hosts
 * are independent: a repo where plugin A declares `gemini` and plugin B declares `kiro` emits both
 * (a root `gemini-extension.json` and a root `POWER.md` — distinct files).
 *
 * @param repoRoot - Absolute repo root (where the artifacts live). Accepted for signature
 *   parallelism with {@link computeRegistryArtifacts}; the bundlers read only the plugin dir.
 * @param plugins - Discovered plugins with name/source/envelope (the registry plugin infos already
 *   collected for {@link computeRegistryArtifacts}). Each `source` resolves the plugin dir.
 * @param _workspace - The validated workspace metadata. Unused by the bundlers today; accepted for
 *   parallelism with the registry compute signature and to future-proof host metadata injection.
 */
export function computeRootArtifacts(
  repoRoot: string,
  plugins: readonly RegistryPluginInfo[],
  _workspace: AipmWorkspace,
  onHostError?: (error: unknown) => void,
  exists = fs.existsSync,
): RootArtifacts {
  const files: RootArtifactFile[] = [];
  const findings: Finding[] = [];
  const owners = new Map<SingleArtifactHost, RegistryPluginInfo>();

  for (const host of SINGLE_ARTIFACT_HOSTS) {
    const declarers = plugins.filter((p) => p.envelope.includes(host));
    if (declarers.length === 0) continue; // no plugin declares this host → nothing to emit
    if (declarers.length > 1) {
      // N>1 gate: ambiguous owner. Suppress emission and flag.
      findings.push(
        singleArtifactHostFinding(
          host,
          declarers.map((p) => p.name),
        ),
      );
      continue;
    }

    const declarer = declarers[0];
    if (declarer !== undefined) owners.set(host, declarer);
  }

  for (const [host, declarer] of owners) {
    const pluginDir = path.resolve(repoRoot, declarer.source);
    try {
      for (const file of readRootHostFiles(host, pluginDir, exists)) files.push(file);
    } catch (err) {
      if (onHostError === undefined) throw err;
      onHostError(err);
    }
  }

  const trackedPaths = [...new Set(files.map((file) => file.relPath))].sort();
  return { files, trackedPaths, findings };
}

function readRootHostFiles(
  host: SingleArtifactHost,
  pluginDir: string,
  exists: typeof fs.existsSync,
): RootArtifactFile[] {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-root-' + host + '-'));
  let regenerated = false;
  try {
    bundleRootHost(host, pluginDir, tempDir, exists);
    regenerated = true;
    return collectFilesRelative(tempDir, exists).map((rel) => ({
      relPath: rel.split(path.sep).join('/'),
      owner: host,
      content: fs.readFileSync(path.join(tempDir, rel)),
    }));
  } finally {
    if ((regenerated || exists !== fs.existsSync) && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  }
}

/**
 * Build a hard `root-artifact-collision` finding for a repo-root path the toolkit would generate
 * but which is already occupied by a file it does NOT track as previously-generated (so the file
 * belongs to the host software / the author). Repo-scoped — names the offending path and its owning
 * target (a single-artifact host or a repo-root registry target such as `open-plugins`).
 */
function rootCollisionFinding(owner: TargetId, relPath: string): Finding {
  return {
    severity: 'hard',
    code: 'root-artifact-collision',
    message:
      `Cannot emit the repo-root '${owner}' artifact: '${relPath}' already exists and is not toolkit-generated. ` +
      `Generation refuses to overwrite repo-root state it does not own.`,
    hint: `Move or remove '${relPath}' (or, if it is stale toolkit output, add it to ${ROOT_MANIFEST_REL.join('/')}) and re-run \`aipm build\`.`,
  };
}

/**
 * Detect repo-root collisions for the freshly computed {@link RootArtifacts}, given the PRIOR
 * tracked set. A file collides when it exists on disk AND its repo-root-relative path is NOT in the
 * prior tracked set — i.e. it is not something the toolkit previously created, so it belongs to the
 * host/author and must not be clobbered (safety guard 3). A clean repo (no pre-existing root files)
 * never collides. Collision is evaluated PER OWNER: if any of an owner's files collide, that owner
 * is suppressed entirely (no partial writes) and a single finding names the first offending path.
 *
 * Returns the collision findings plus the set of owners that collided (so the caller can skip
 * writing/tracking their files). Pure — no I/O beyond `existsSync`.
 */
export function detectRootCollisions(
  repoRoot: string,
  artifacts: RootArtifacts,
  priorTracked: readonly string[],
): { findings: Finding[]; collidedOwners: Set<TargetId> } {
  const priorSet = new Set(priorTracked);
  const findings: Finding[] = [];
  const collidedOwners = new Set<TargetId>();

  for (const file of artifacts.files) {
    if (collidedOwners.has(file.owner)) continue; // already flagged this owner's first collision
    const abs = path.join(repoRoot, ...file.relPath.split('/'));
    if (fs.existsSync(abs) && !priorSet.has(file.relPath)) {
      findings.push(rootCollisionFinding(file.owner, file.relPath));
      collidedOwners.add(file.owner);
    }
  }

  return { findings, collidedOwners };
}

/**
 * Serialize the generated-root sidecar manifest. Shape: `{ version: 1, paths: string[] }` where
 * `paths` is the sorted set of repo-root-relative POSIX paths the toolkit generated (the sidecar
 * itself is NOT listed — it is tracked separately and always lives at {@link rootManifestPath}).
 * 2-space JSON + trailing newline, byte-stable so the freshness compare is exact.
 */
export function serializeRootManifest(trackedPaths: readonly string[]): string {
  // Canonicalize (dedupe + sort) so the bytes are identical regardless of caller. The freshness
  // oracle in validate.ts collects one entry per emitting host, so a path shared by both the gemini
  // and kiro bundles (e.g. `skills/<name>/SKILL.md`) appears twice; build passes a deduped set.
  // Without deduping here, those two callers would serialize differently and the sidecar would read
  // as perpetually stale (a false `freshness` finding).
  return `${JSON.stringify({ version: 1, paths: [...new Set(trackedPaths)].sort() }, null, 2)}\n`;
}

/**
 * Read the prior generated-root sidecar manifest, returning the tracked-path set it recorded.
 * Returns an empty array when the sidecar is absent or unparseable — a missing/corrupt sidecar is
 * treated as "nothing tracked yet" (a clean first build), and the collision guard then protects any
 * pre-existing root files.
 * POSIX-separated paths are returned as-is.
 */
export function readRootManifestPaths(repoRoot: string): string[] {
  const manifestPath = rootManifestPath(repoRoot);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return parseRootManifestPaths(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [];
  }
}

export function parseRootManifestPaths(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'paths' in parsed &&
      Array.isArray((parsed as { paths: unknown }).paths)
    ) {
      const { paths } = parsed as { paths: unknown[] };
      return paths.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // Corrupt sidecar → treat as nothing tracked; the collision guard protects existing files.
  }
  return [];
}

/** Collect every file path under `dir`, relative to `dir`. Returns `[]` if `dir` is absent. */
export function collectFilesRelative(dir: string, exists = fs.existsSync): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of collectFilesRelative(path.join(dir, entry.name), exists)) {
        out.push(path.join(entry.name, sub));
      }
    } else {
      out.push(entry.name);
    }
  }
  return out;
}
