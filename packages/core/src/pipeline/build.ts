/**
 * Build orchestrator (§5.2).
 *
 * `runBuild` loads each plugin's envelope, dispatches to the per-target build steps, writes the
 * generated artifacts, and (per §5.4) runs validation before returning. The pipeline holds no
 * target-specific transformation logic — it dispatches to the per-target internal modules under
 * `targets/<id>/` (§7.2). Cross-target imports between `targets/<X>` and `targets/<Y>` are
 * forbidden, but the pipeline is permitted to orchestrate all of them.
 *
 * **Sentinel scope (§4.3).** Only the in-plugin-dir generated hook JSONs (`hooks/claude.json`,
 * `hooks/hooks.json`) carry a `_generated` JSON sentinel. The `dist/**` bundle trees are
 * wholly-generated and stay sentinel-less so they remain byte-identical to the committed
 * template oracle; freshness for those is a whole-tree regeneration compare (§10.5).
 *
 * @see docs/specs/architecture.md §5.2 (build phase), §5.4 (phase invariants), §7.2, §10.5
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseClaudeHooksYaml } from '../targets/claude/transform.js';
import { convertClaudeHooksYamlToGeminiJson } from '../targets/gemini/transform.js';
import { bundleGeminiPlugin } from '../targets/gemini/bundle.js';
import { bundleKiroPlugin } from '../targets/kiro/bundle.js';

import type { AipmWorkspace } from '../config.js';

import { discoverPlugins } from './discover.js';
import { createConfigCache, loadPluginConfig, loadWorkspaceConfig } from './load-config.js';
import type { ConfigCache } from './load-config.js';
import { applyJsonSentinel } from './sentinel.js';
import type { SentinelMode } from './sentinel.js';
import { runValidate } from './validate.js';
import type { BuildOptions, BuildResult, Finding, GeneratedFile, TargetId } from './types.js';

// ---------------------------------------------------------------------------
// Shared generation primitives (consumed by build AND freshness — §10.5)
// ---------------------------------------------------------------------------

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
  /** Which target's build step produced this file. */
  target: TargetId;
  /** Exact bytes the build writes (sentinel included). */
  expectedContent: string;
}

/** First existing hooks YAML candidate (`claude.yaml`, then `claude.yml`), or `undefined`. */
function findHooksYaml(pluginDir: string): { absPath: string; source: string } | undefined {
  for (const name of ['claude.yaml', 'claude.yml']) {
    const absPath = path.join(pluginDir, 'hooks', name);
    if (fs.existsSync(absPath)) {
      return { absPath, source: `hooks/${name}` };
    }
  }
  return undefined;
}

/**
 * Compute every in-plugin-dir generated hook JSON for a plugin given its envelope, **without
 * writing**. This is the single source of truth shared by `runBuild` and the freshness check.
 *
 * - `claude` in envelope + a hooks YAML present → `hooks/claude.json` (Claude JSON + sentinel).
 * - `gemini` in envelope + a hooks YAML present → `hooks/hooks.json` (Gemini JSON + sentinel).
 *
 * The sentinel is applied to the **parsed object** so the on-disk file carries a top-level
 * `_generated` field (§4.3), serialized 2-space + trailing newline.
 *
 * @throws {Error} If the hooks YAML is malformed or fails the Claude hooks schema.
 */
export function computePluginHookArtifacts(
  pluginDir: string,
  envelope: readonly TargetId[],
): PluginHookArtifact[] {
  const yaml = findHooksYaml(pluginDir);
  if (!yaml) return [];

  const envelopeSet = new Set(envelope);
  const artifacts: PluginHookArtifact[] = [];
  const yamlContent = fs.readFileSync(yaml.absPath, 'utf-8');

  if (envelopeSet.has('claude')) {
    // Parse+validate to a typed object, then attach the JSON sentinel.
    const parsed = parseClaudeHooksYaml(yamlContent);
    artifacts.push({
      absPath: path.join(pluginDir, 'hooks', 'claude.json'),
      source: yaml.source,
      sentinelMode: 'json-field',
      target: 'claude',
      expectedContent: applyJsonSentinel(parsed, yaml.source),
    });
  }

  if (envelopeSet.has('gemini')) {
    // The Gemini transform returns a serialized string; parse it back to an object so the
    // sentinel sits at the top level. applyJsonSentinel re-serializes 2-space + newline,
    // matching the transform's own format, so the body round-trips byte-for-byte.
    const geminiJson = convertClaudeHooksYamlToGeminiJson(yamlContent);
    const geminiObj = JSON.parse(geminiJson) as unknown;
    artifacts.push({
      absPath: path.join(pluginDir, 'hooks', 'hooks.json'),
      source: yaml.source,
      sentinelMode: 'json-field',
      target: 'gemini',
      expectedContent: applyJsonSentinel(geminiObj, yaml.source),
    });
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
): DistBundle[] {
  const pluginName = path.basename(pluginDir);
  const envelopeSet = new Set(envelope);
  const bundles: DistBundle[] = [];

  if (envelopeSet.has('gemini')) {
    bundles.push({
      target: 'gemini',
      destDir: path.join(distDir, 'gemini', pluginName),
      regenerate: (into) => {
        bundleGeminiPlugin(pluginDir, into);
      },
    });
  }

  if (envelopeSet.has('kiro')) {
    bundles.push({
      target: 'kiro',
      destDir: path.join(distDir, 'kiro', pluginName),
      regenerate: (into) => {
        bundleKiroPlugin(pluginDir, into);
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

/** Where each registry-backed target's `marketplace.json` lives, relative to the repo root. */
const REGISTRY_REL_PATHS: Record<'claude' | 'cursor' | 'codex', readonly string[]> = {
  claude: ['.claude-plugin', 'marketplace.json'],
  cursor: ['.cursor-plugin', 'marketplace.json'],
  codex: ['.agents', 'plugins', 'marketplace.json'],
};

/**
 * Absolute paths of every registry the toolkit MANAGES under a repo root (one per registry-backed
 * target), regardless of whether the current envelope produces it. Used to detect **orphaned**
 * registries — a committed `marketplace.json` for a target no longer declared by any plugin —
 * which `runBuild` removes and the validator flags as stale. Shared so build and validate agree
 * on exactly which files generation owns (and never touch anything else).
 */
export function managedRegistryPaths(repoRoot: string): string[] {
  return Object.values(REGISTRY_REL_PATHS).map((rel) => path.join(repoRoot, ...rel));
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
 * Compute the generated marketplace registries for a repo, **without writing**. The single source
 * of truth shared by `runBuild` (which writes `expectedContent`) and the freshness check (which
 * compares the on-disk bytes against it).
 *
 * A registry file is produced for each registry-backed target (`claude` → `.claude-plugin/`,
 * `cursor` → `.cursor-plugin/`, `codex` → `.agents/plugins/`) that appears in **at least one**
 * plugin's envelope. Each registry lists exactly the plugins whose envelope includes that target,
 * in the order given (callers pass plugins sorted by discovery). Registries are sentinel-less.
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

  for (const target of ['claude', 'cursor', 'codex'] as const) {
    const members = plugins.filter((p) => p.envelope.includes(target));
    if (members.length === 0) continue; // no plugin declares this target → no registry file

    const obj =
      target === 'codex'
        ? buildCodexRegistry(workspace, members)
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
function bundleHostToTemp(host: SingleArtifactHost, pluginDir: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `aipm-root-${host}-`));
  if (host === 'gemini') {
    bundleGeminiPlugin(pluginDir, tempDir);
  } else {
    bundleKiroPlugin(pluginDir, tempDir);
  }
  return tempDir;
}

/**
 * A single repo-root file the toolkit generates for a single-artifact host. `relPath` is the path
 * relative to the repo root (POSIX-separated, the tracked-set form); `content` is the exact bytes.
 */
interface RootArtifactFile {
  /** Repo-root-relative POSIX path (e.g. `gemini-extension.json`, `commands/foo.toml`). */
  relPath: string;
  /** The host whose bundle produced this file. */
  host: SingleArtifactHost;
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
): RootArtifacts {
  const files: RootArtifactFile[] = [];
  const trackedPaths = new Set<string>();
  const findings: Finding[] = [];

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

    // Exactly one declarer: bundle it into temp, then capture its files as repo-root artifacts.
    const declarer = declarers[0];
    if (declarer === undefined) continue; // unreachable (length === 1), satisfies noUncheckedIndexedAccess
    // `source` is `./<rel>` POSIX from the repo root; resolve to the absolute plugin dir.
    const pluginDir = path.resolve(repoRoot, declarer.source);

    let tempDir: string | undefined;
    try {
      tempDir = bundleHostToTemp(host, pluginDir);
      for (const rel of collectFilesRelative(tempDir)) {
        // Tracked set is POSIX-separated (stable across platforms; the freshness oracle and
        // sidecar compare against this exact form).
        const relPosix = rel.split(path.sep).join('/');
        trackedPaths.add(relPosix);
        files.push({
          relPath: relPosix,
          host,
          content: fs.readFileSync(path.join(tempDir, rel)),
        });
      }
    } finally {
      if (tempDir !== undefined && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    }
  }

  return { files, trackedPaths: [...trackedPaths].sort(), findings };
}

/**
 * Build a hard `root-artifact-collision` finding for a repo-root path the toolkit would generate
 * but which is already occupied by a file it does NOT track as previously-generated (so the file
 * belongs to the host software / the author). Repo-scoped — names the offending path.
 */
function rootCollisionFinding(host: SingleArtifactHost, relPath: string): Finding {
  return {
    severity: 'hard',
    code: 'root-artifact-collision',
    message:
      `Cannot emit the repo-root '${host}' artifact: '${relPath}' already exists and is not toolkit-generated. ` +
      `Generation refuses to overwrite repo-root state it does not own.`,
    hint: `Move or remove '${relPath}' (or, if it is stale toolkit output, add it to ${ROOT_MANIFEST_REL.join('/')}) and re-run \`aipm build\`.`,
  };
}

/**
 * Detect repo-root collisions for the freshly computed {@link RootArtifacts}, given the PRIOR
 * tracked set. A file collides when it exists on disk AND its repo-root-relative path is NOT in the
 * prior tracked set — i.e. it is not something the toolkit previously created, so it belongs to the
 * host/author and must not be clobbered (safety guard 3). A clean repo (no pre-existing root files)
 * never collides. Collision is evaluated PER HOST: if any of a host's files collide, that host is
 * suppressed entirely (no partial writes) and a single finding names the first offending path.
 *
 * Returns the collision findings plus the set of hosts that collided (so the caller can skip
 * writing/tracking their files). Pure — no I/O beyond `existsSync`.
 */
export function detectRootCollisions(
  repoRoot: string,
  artifacts: RootArtifacts,
  priorTracked: readonly string[],
): { findings: Finding[]; collidedHosts: Set<SingleArtifactHost> } {
  const priorSet = new Set(priorTracked);
  const findings: Finding[] = [];
  const collidedHosts = new Set<SingleArtifactHost>();

  for (const file of artifacts.files) {
    if (collidedHosts.has(file.host)) continue; // already flagged this host's first collision
    const abs = path.join(repoRoot, ...file.relPath.split('/'));
    if (fs.existsSync(abs) && !priorSet.has(file.relPath)) {
      findings.push(rootCollisionFinding(file.host, file.relPath));
      collidedHosts.add(file.host);
    }
  }

  return { findings, collidedHosts };
}

/**
 * Serialize the generated-root sidecar manifest. Shape: `{ version: 1, paths: string[] }` where
 * `paths` is the sorted set of repo-root-relative POSIX paths the toolkit generated (the sidecar
 * itself is NOT listed — it is tracked separately and always lives at {@link rootManifestPath}).
 * 2-space JSON + trailing newline, byte-stable so the freshness compare is exact.
 */
export function serializeRootManifest(trackedPaths: readonly string[]): string {
  return `${JSON.stringify({ version: 1, paths: [...trackedPaths].sort() }, null, 2)}\n`;
}

/**
 * Read the prior generated-root sidecar manifest, returning the tracked-path set it recorded.
 * Returns an empty array when the sidecar is absent or unparseable — a missing/corrupt sidecar is
 * treated as "nothing tracked yet" (a clean first build), and the collision guard then protects any
 * pre-existing root files. POSIX-separated paths are returned as-is.
 */
export function readRootManifestPaths(repoRoot: string): string[] {
  const manifestPath = rootManifestPath(repoRoot);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
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
export function collectFilesRelative(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of collectFilesRelative(path.join(dir, entry.name))) {
        out.push(path.join(entry.name, sub));
      }
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build one plugin
// ---------------------------------------------------------------------------

/** Write a file ensuring its parent directory exists. */
function writeFileEnsuringDir(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

/**
 * Build a single plugin: load envelope, emit in-plugin hook JSONs and dist bundles, and return
 * the `BuildResult` (without running validation — the caller orchestrates §5.4 validation once).
 */
async function buildOnePlugin(
  pluginDir: string,
  distDir: string,
  cache?: ConfigCache,
): Promise<BuildResult> {
  const start = performance.now();
  const pluginName = path.basename(pluginDir);

  const config = await loadPluginConfig(pluginDir, cache);
  const envelope = config.targets;

  const artifacts: GeneratedFile[] = [];

  // ── In-plugin-dir generated hook JSONs (sentinel-carrying) ────────────────
  for (const hookArtifact of computePluginHookArtifacts(pluginDir, envelope)) {
    writeFileEnsuringDir(hookArtifact.absPath, hookArtifact.expectedContent);
    artifacts.push({
      path: hookArtifact.absPath,
      source: `${pluginName}/${hookArtifact.source}`,
      target: hookArtifact.target,
    });
  }

  // ── dist/** bundle trees (sentinel-less, byte-parity with oracle) ──────────
  for (const bundle of computeDistBundles(pluginDir, distDir, envelope)) {
    bundle.regenerate(bundle.destDir);
    for (const rel of collectFilesRelative(bundle.destDir)) {
      artifacts.push({
        path: path.join(bundle.destDir, rel),
        source: pluginName,
        target: bundle.target,
      });
    }
  }

  // codex / cursor / vercel emit no mechanical build output — nothing to do.

  return {
    plugin: pluginName,
    pluginDir,
    artifacts,
    durationMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build one plugin or every plugin under a repo root (§8.1). `targetPath` is detected as a single
 * plugin directory (contains `aipm.config.ts`) or a repo root (contains a `plugins/` directory).
 *
 * After emitting artifacts, runs `runValidate(targetPath, { skipFreshness: true })` per §5.4. When
 * `opts.failFast` is set and validation reports hard findings, throws an Error summarizing them;
 * otherwise the build results are returned and the caller (CLI) decides the exit code.
 *
 * @param targetPath - Absolute path to a plugin directory or repo root.
 * @param opts - Build options.
 * @returns One `BuildResult` per built plugin (length-1 for single-plugin input).
 * @throws {Error} If `targetPath` is neither a plugin nor a repo root, a config fails to load,
 *   a transform fails, or (when `failFast`) post-build validation reports hard findings.
 */
export async function runBuild(targetPath: string, opts?: BuildOptions): Promise<BuildResult[]> {
  const { repoRoot, pluginDirs, distDir } = await discoverPlugins(targetPath);

  // One per-invocation config memo shared across the build loop and registry collection, so each
  // plugin's aipm.config.ts is transpiled once rather than reloaded per phase (see ConfigCache).
  const configCache = createConfigCache();

  const results: BuildResult[] = [];
  for (const pluginDir of pluginDirs) {
    results.push(await buildOnePlugin(pluginDir, distDir, configCache));
  }

  // ── Marketplace registries (opt-in via aipm.workspace.ts at the repo root) ──
  // When the repo has opted into registry generation, the three marketplace.json files are
  // GENERATED here (subsuming the hand-authored registries + validateMarketplaceRegistration).
  // Registries are repo-level, so we compute them from EVERY plugin under the repo root — not just
  // the one a single-plugin `targetPath` named — so a partial build never drops sibling entries.
  // Re-discovering from `repoRoot` (rather than reusing `pluginDirs`, which holds only the named
  // plugin for single-plugin input) is what makes the registry repo-complete. When no
  // `aipm.workspace.ts` is present, generation does nothing and the registries stay hand-authored.
  const workspace = await loadWorkspaceConfig(repoRoot);
  if (workspace !== undefined) {
    // For repo-root input, pluginDirs already covers the whole repo — reuse it (and the warm
    // config cache) instead of re-discovering and reloading. Only single-plugin input needs a
    // repo-wide re-scan to make the registry repo-complete.
    const isRepoRoot = path.resolve(targetPath) === repoRoot;
    const allPluginDirs = isRepoRoot ? pluginDirs : (await discoverPlugins(repoRoot)).pluginDirs;
    const registryPlugins = await collectRegistryPlugins(repoRoot, allPluginDirs, configCache);
    const registries = computeRegistryArtifacts(repoRoot, registryPlugins, workspace);
    const expectedPaths = new Set(registries.map((r) => r.absPath));
    for (const registry of registries) {
      writeFileEnsuringDir(registry.absPath, registry.expectedContent);
    }
    // Remove ORPHANED registries: a managed `marketplace.json` for a target no longer declared by
    // any plugin (e.g. the last `claude` plugin was dropped). Without this, a stale generated
    // registry would linger in the working tree and stay committed. Only the toolkit-managed
    // registry paths are ever touched.
    for (const orphan of managedRegistryPaths(repoRoot)) {
      if (!expectedPaths.has(orphan) && fs.existsSync(orphan)) {
        fs.rmSync(orphan);
      }
    }
    // Record the generated registries as repo-level artifacts on every built plugin's result so
    // they surface in BuildResult regardless of which plugin a single-plugin build targeted.
    for (const result of results) {
      for (const registry of registries) {
        result.artifacts.push({ path: registry.absPath, target: registry.target });
      }
    }

    // ── Single-artifact-host repo-root native emission (gemini / kiro) ──────────
    // These hosts install ONE extension/power per repo from the repo ROOT and have no marketplace
    // concept, so the artifact is emitted at the repo root (not under dist/). Like registries, this
    // is repo-level and computed from EVERY plugin so the N=1 gate sees the whole repo. The emit is
    // safety-guarded: bundling happens in temp (never against repoRoot), a collision guard refuses
    // to overwrite non-generated root files, and orphan removal is bounded to the prior tracked set
    // recorded in the committed sidecar manifest.
    const priorTracked = readRootManifestPaths(repoRoot);
    const root = computeRootArtifacts(repoRoot, registryPlugins, workspace);
    const { collidedHosts } = detectRootCollisions(repoRoot, root, priorTracked);

    // The tracked set is only the paths we actually WRITE — files of a collided (suppressed) host
    // are neither written nor tracked, so orphan removal can never delete a host-owned collider.
    const writtenTracked = new Set<string>();
    for (const file of root.files) {
      if (collidedHosts.has(file.host)) continue;
      const abs = path.join(repoRoot, ...file.relPath.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content);
      writtenTracked.add(file.relPath);
      for (const result of results) {
        result.artifacts.push({ path: abs, target: file.host });
      }
    }

    // Orphan removal: any path in the PRIOR tracked set that is no longer generated this run is a
    // path the toolkit previously created and now owns the right to delete (e.g. the gemini plugin
    // was dropped, or a second gemini plugin disabled emission via the N=1 gate). Bounded strictly
    // to `priorTracked` — we never delete a file we did not previously record as generated.
    for (const rel of priorTracked) {
      if (writtenTracked.has(rel)) continue;
      const abs = path.join(repoRoot, ...rel.split('/'));
      if (fs.existsSync(abs)) fs.rmSync(abs);
    }

    // Write/update the sidecar manifest (itself a generated, freshness-checked artifact). When the
    // tracked set is empty AND no sidecar existed, skip writing so a repo that never used these
    // hosts stays free of an empty `.aipm/` dir; otherwise keep it in sync (including emptying it).
    const manifestAbs = rootManifestPath(repoRoot);
    const trackedSorted = [...writtenTracked].sort();
    if (trackedSorted.length > 0 || fs.existsSync(manifestAbs)) {
      writeFileEnsuringDir(manifestAbs, serializeRootManifest(trackedSorted));
      for (const result of results) {
        result.artifacts.push({ path: manifestAbs, target: 'gemini' });
      }
    }
  }

  // §5.4: build runs validate before returning success. Skip freshness here — we just wrote the
  // artifacts, so they are fresh by construction; running it would be redundant work.
  const validation = await runValidate(targetPath, { skipFreshness: true });
  if (opts?.failFast && !validation.passed) {
    const hardFindings = validation.findings.filter((f) => f.severity === 'hard');
    const summary = hardFindings
      .map((f) => `  [${f.plugin ?? '?'}] ${f.code}: ${f.message}`)
      .join('\n');
    throw new Error(
      `Build produced ${String(hardFindings.length)} hard validation finding(s):\n${summary}`,
    );
  }

  return results;
}

/**
 * Regenerate a dist bundle into a fresh temp directory and return that directory. The caller is
 * responsible for removing it. Used by the freshness check (§10.5) to byte-compare against the
 * on-disk bundle without disturbing it.
 */
export function regenerateBundleToTemp(bundle: DistBundle): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-freshness-'));
  bundle.regenerate(tempDir);
  return tempDir;
}
