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

import { discoverPlugins } from './discover.js';
import { loadPluginConfig } from './load-config.js';
import { applyJsonSentinel } from './sentinel.js';
import type { SentinelMode } from './sentinel.js';
import { runValidate } from './validate.js';
import type { BuildOptions, BuildResult, GeneratedFile, TargetId } from './types.js';

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
async function buildOnePlugin(pluginDir: string, distDir: string): Promise<BuildResult> {
  const start = performance.now();
  const pluginName = path.basename(pluginDir);

  const config = await loadPluginConfig(pluginDir);
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
  const { pluginDirs, distDir } = discoverPlugins(targetPath);

  const results: BuildResult[] = [];
  for (const pluginDir of pluginDirs) {
    results.push(await buildOnePlugin(pluginDir, distDir));
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
