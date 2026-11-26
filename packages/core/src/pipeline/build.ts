/**
 * Build orchestrator (§5.2).
 *
 * `runBuild` loads each plugin's envelope, dispatches to the per-target build steps, writes the
 * generated artifacts, and (per §5.4) runs validation before returning. The pipeline holds no
 * target-specific transformation logic — it dispatches to the per-target internal modules under
 * `targets/<id>/` (§7.2). Cross-target imports between `targets/<X>` and `targets/<Y>` are
 * forbidden, but the pipeline is permitted to orchestrate all of them.
 *
 * **Sentinel scope (§4.3).** Only the in-plugin-dir generated hook files carry a sentinel:
 * `hooks/cursor.json` inline as a `_generated` JSON field, and `hooks/hooks.json` (Claude) in a
 * `hooks/hooks.json.generated` sidecar, because Claude hosts accept no extra keys in that file. The
 * `dist/**` bundle trees are
 * wholly-generated and stay sentinel-less so they remain byte-identical to the committed
 * template oracle; freshness for those is a whole-tree regeneration compare (§10.5).
 *
 * @see docs/specs/architecture.md §5.2 (build phase), §5.4 (phase invariants), §7.2, §10.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { CLAUDE_HOOKS_FILENAME, CLAUDE_HOOKS_SOURCES } from '../targets/claude/transform.js';
import {
  collectFilesRelative,
  collectRegistryPlugins,
  computeDistBundles,
  computePluginHookArtifacts,
  computeRegistryArtifacts,
  computeRootArtifacts,
  detectRootCollisions,
  isRootRegistryTarget,
  managedVendorRegistryPaths,
  mergeRootArtifacts,
  readRootManifestPaths,
  rootManifestPath,
  rootRegistryArtifactFiles,
  serializeRootManifest,
  type PluginHookArtifact,
} from './artifacts.js';
import { discoverPlugins } from './discover.js';
import {
  assertGeneratorNotDowngraded,
  getGeneratorVersion,
  type StampedArtifact,
} from './generator-version.js';
import { createConfigCache, loadPluginConfig, loadWorkspaceConfig } from './load-config.js';
import type { ConfigCache } from './load-config.js';
import { isToolkitSentinelFor, readSentinelVersion, sidecarPath } from './sentinel.js';
import type { BuildOptions, BuildOutcome, BuildResult, GeneratedFile, TargetId } from './types.js';
import { runValidate } from './validate.js';

// ---------------------------------------------------------------------------
// Build one plugin
// ---------------------------------------------------------------------------

/** Write a file ensuring its parent directory exists. */
function writeFileEnsuringDir(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

/**
 * Refuse to write a hook artifact anywhere but a regular file inside the plugin: through a
 * `hooks/` directory that resolves outside it, or to a path that is a symbolic link or other
 * non-file entry. Writing there would change a file the plugin does not own.
 *
 * @throws {Error} If any planned hook artifact would be written outside a regular in-plugin file.
 */
function assertHookArtifactsInsidePlugin(
  pluginDir: string,
  hookArtifacts: readonly PluginHookArtifact[],
): void {
  const plugin = path.basename(pluginDir);
  // `.native` returns the on-disk spelling, so case-insensitive aliases compare equal.
  const realPlugin = fs.realpathSync.native(pluginDir);
  for (const dir of new Set(hookArtifacts.map((a) => path.dirname(a.absPath)))) {
    if (!fs.existsSync(dir)) continue;
    const rel = path.relative(realPlugin, fs.realpathSync.native(dir));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(
        `${plugin}: ${path.relative(pluginDir, dir)}/ resolves outside the plugin directory, so ` +
          `aipm build will not write into it. Replace the link with a real directory and rebuild.`,
      );
    }
  }
  for (const { absPath } of hookArtifacts) {
    const stat = fs.lstatSync(absPath, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) {
      throw new Error(
        `${plugin}: ${path.relative(pluginDir, absPath)} is not a regular file, so aipm build will ` +
          `not write to it. Replace it with a regular file (or remove it) and rebuild.`,
      );
    }
  }
}

/**
 * Write `content` to `absPath` by way of a new temporary sibling and a rename, so a failed or
 * short write never leaves a partial file at `absPath`. Used for the ownership marker the next
 * build trusts: a truncated marker would make the build refuse its own output. An unchanged file
 * is left alone, and a replaced one keeps its permission bits.
 */
function writeFileReplacing(absPath: string, content: string): void {
  const existing = fs.statSync(absPath, { throwIfNoEntry: false });
  if (existing !== undefined && fs.readFileSync(absPath, 'utf-8') === content) return;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const temp = `${absPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  // `wx` creates the temporary file or fails, so cleanup only ever removes a file this call made.
  // Writing through that descriptor works even when the mode is read-only. A new file gets the
  // usual umask-filtered mode; a replaced one gets the old file's exact mode.
  const fd = fs.openSync(temp, 'wx', existing?.mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      if (existing !== undefined) fs.fchmodSync(fd, existing.mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, absPath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Refuse to overwrite a `hooks/hooks.json` or its sidecar that the toolkit did not write.
 *
 * `hooks/hooks.json` is a host-native default (Claude Code, Codex and Open Plugins all read it), so
 * a plugin may carry a hand-authored one, and its `.generated` name may be taken by another tool.
 * The build only replaces the pair when it is provably toolkit-owned:
 * - a sidecar, if present, must carry this toolkit's sentinel for the hooks YAML. The build writes
 *   the sidecar before the body, so a build interrupted between the two still owns the pair;
 * - with no sidecar, the body must carry the inline `_generated` sentinel that earlier toolkit
 *   versions wrote on the in-plugin Gemini copy.
 * ({@link assertHookArtifactsInsidePlugin} has already refused links and non-file paths.) Anything
 * else would be silently discarded, so the build fails and the author ports it into
 * `hooks/claude.yaml`.
 *
 * @throws {Error} If the build would replace a file it cannot prove it owns.
 */
function assertClaudeHooksFileOwned(
  pluginDir: string,
  hookArtifacts: readonly PluginHookArtifact[],
): void {
  const hooksJson = path.join(pluginDir, 'hooks', CLAUDE_HOOKS_FILENAME);
  if (!hookArtifacts.some((a) => a.absPath === hooksJson)) return;
  const sidecar = sidecarPath(hooksJson);
  const plugin = path.basename(pluginDir);
  if (fs.existsSync(sidecar)) {
    if (isToolkitSentinelFor(fs.readFileSync(sidecar, 'utf-8'), 'sidecar', CLAUDE_HOOKS_SOURCES)) {
      return;
    }
    throw new Error(
      `${plugin}: hooks/hooks.json.generated exists and was not written by aipm, so building would ` +
        `overwrite it. Remove or rename it, then rebuild.`,
    );
  }
  if (!fs.existsSync(hooksJson)) return;
  if (
    isToolkitSentinelFor(fs.readFileSync(hooksJson, 'utf-8'), 'json-field', CLAUDE_HOOKS_SOURCES)
  ) {
    return;
  }
  throw new Error(
    `${plugin}: hooks/hooks.json exists and was not generated by aipm, so building would overwrite ` +
      `it. Port its hooks into hooks/claude.yaml, check the rebuilt file, and only then delete the original.`,
  );
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
  const hookArtifacts = computePluginHookArtifacts(pluginDir, envelope);
  assertHookArtifactsInsidePlugin(pluginDir, hookArtifacts);
  assertClaudeHooksFileOwned(pluginDir, hookArtifacts);
  for (const hookArtifact of hookArtifacts) {
    if (
      hookArtifact.absPath === sidecarPath(path.join(pluginDir, 'hooks', CLAUDE_HOOKS_FILENAME))
    ) {
      writeFileReplacing(hookArtifact.absPath, hookArtifact.expectedContent);
    } else {
      writeFileEnsuringDir(hookArtifact.absPath, hookArtifact.expectedContent);
    }
    if (hookArtifact.executable) {
      // writeFileSync's mode argument only applies at file creation, so an existing file (e.g. a
      // stale non-executable copy from before this artifact carried `executable: true`) would
      // otherwise keep its old permission bits — chmod unconditionally instead.
      fs.chmodSync(hookArtifact.absPath, 0o755);
    }
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

  // codex / vercel emit no mechanical build output — nothing to do. (cursor's hooks/cursor.json
  // is emitted above via computePluginHookArtifacts; it has no dist bundle.)

  return {
    plugin: pluginName,
    pluginDir,
    artifacts,
    durationMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Generator-version downgrade guard (§4.3.1)
// ---------------------------------------------------------------------------

/**
 * Scan the EXISTING (committed) sentinel-carrying hook artifacts under each plugin for their
 * stamped generator version (§4.3.1), returning one {@link StampedArtifact} per artifact that
 * carries a readable version stamp. Artifacts that are absent, unstamped (produced before version
 * stamping), or whose stamp is unreadable are simply omitted — they impose no downgrade constraint.
 *
 * Reuses {@link computePluginHookArtifacts} to enumerate exactly the files the build owns, so the
 * guard inspects the same artifact set the build would overwrite (never author-authored files).
 * The enumeration's stamped `expectedContent` is irrelevant here — only the on-disk bytes are read.
 */
async function collectStampedArtifacts(
  repoRoot: string,
  pluginDirs: readonly string[],
  cache: ConfigCache,
): Promise<StampedArtifact[]> {
  const stamped: StampedArtifact[] = [];
  for (const pluginDir of pluginDirs) {
    const config = await loadPluginConfig(pluginDir, cache);
    let artifacts: PluginHookArtifact[];
    try {
      artifacts = computePluginHookArtifacts(pluginDir, config.targets);
    } catch {
      // A malformed hooks source can't be enumerated; the build itself will surface the error.
      continue;
    }
    for (const artifact of artifacts) {
      if (!fs.existsSync(artifact.absPath)) continue;
      const onDisk = fs.readFileSync(artifact.absPath, 'utf-8');
      const version = readSentinelVersion(onDisk, artifact.sentinelMode);
      if (version === undefined) continue;
      stamped.push({
        path: path.relative(repoRoot, artifact.absPath),
        version,
      });
    }
    // Earlier toolkit versions stamped the in-plugin Gemini `hooks/hooks.json` inline
    // (`_generated.version`). When this build replaces that file with Claude's hooks, a newer
    // toolkit stamp there must still block an older generator. Another tool's marker is ignored.
    const hooksJson = path.join(pluginDir, 'hooks', CLAUDE_HOOKS_FILENAME);
    if (artifacts.some((a) => a.absPath === hooksJson) && fs.existsSync(hooksJson)) {
      const onDisk = fs.readFileSync(hooksJson, 'utf-8');
      const version = isToolkitSentinelFor(onDisk, 'json-field', CLAUDE_HOOKS_SOURCES)
        ? readSentinelVersion(onDisk, 'json-field')
        : undefined;
      if (version !== undefined) {
        stamped.push({ path: path.relative(repoRoot, hooksJson), version });
      }
    }
  }
  return stamped;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build one plugin or every plugin under a repo root (§8.1). `targetPath` is detected as a single
 * plugin directory (contains `aipm.config.ts`) or a repo root (contains a `plugins/` directory).
 *
 * After emitting artifacts, validates the on-disk state once (§5.4). When `opts.failFast` is set
 * and validation reports hard findings outside freshness checks, throws an Error summarizing them.
 *
 * @param targetPath - Absolute path to a plugin directory or repo root.
 * @param opts - Build options.
 * @returns One `BuildResult` per built plugin and the combined validation result.
 * @throws {Error} If `targetPath` is neither a plugin nor a repo root, a config fails to load,
 *   a transform fails, or (when `failFast`) post-build validation reports hard non-freshness findings.
 */
export async function runBuild(targetPath: string, opts?: BuildOptions): Promise<BuildOutcome> {
  const { repoRoot, pluginDirs, distDir } = await discoverPlugins(targetPath);

  // One per-invocation config memo shared across the build loop and registry collection, so each
  // plugin's aipm.config.ts is transpiled once rather than reloaded per phase (see ConfigCache).
  const configCache = createConfigCache();

  // ── Generator-version downgrade guard (§4.3.1) ────────────────────────────
  // BEFORE writing anything, refuse to build if the installed generator is OLDER than the version
  // stamped into an existing committed artifact — otherwise the build would silently revert those
  // files to the older generator's output. The guard is all-or-nothing: on a refusal nothing is
  // written, so even sentinel-less artifacts (dist/**, registries) are protected from the stale
  // toolkit. Equal-or-newer installs, unstamped/first-time trees, and `--force-downgrade` proceed.
  const stampedArtifacts = await collectStampedArtifacts(repoRoot, pluginDirs, configCache);
  assertGeneratorNotDowngraded(getGeneratorVersion(), stampedArtifacts, opts?.forceDowngrade);

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
    // Split vendor-subdirectory registries (written + orphan-swept here, unchanged) from repo-root
    // registries (open-plugins), whose writing/orphan-removal is collision-guarded via the
    // generated-root sidecar below (OP-D5/VT-4) so a foreign root marketplace.json is never touched.
    const vendorRegistries = registries.filter((r) => !isRootRegistryTarget(r.target));
    const rootRegistries = registries.filter((r) => isRootRegistryTarget(r.target));
    const vendorExpectedPaths = new Set(vendorRegistries.map((r) => r.absPath));
    for (const registry of vendorRegistries) {
      writeFileEnsuringDir(registry.absPath, registry.expectedContent);
    }
    // Remove ORPHANED vendor registries: a managed vendor `marketplace.json` for a target no longer
    // declared by any plugin (e.g. the last `claude` plugin was dropped). Only the toolkit-managed
    // vendor registry paths are ever touched — repo-root registries are handled by the sidecar path.
    for (const orphan of managedVendorRegistryPaths(repoRoot)) {
      if (!vendorExpectedPaths.has(orphan) && fs.existsSync(orphan)) {
        fs.rmSync(orphan);
      }
    }
    // Record the generated vendor registries as repo-level artifacts on every built plugin's result
    // so they surface in BuildResult regardless of which plugin a single-plugin build targeted.
    // (Root registries are recorded below, once the collision guard confirms they were emitted.)
    for (const result of results) {
      for (const registry of vendorRegistries) {
        result.artifacts.push({ path: registry.absPath, target: registry.target });
      }
    }

    // ── Repo-root native emission (gemini / kiro + repo-root registries) ────────
    // Single-artifact hosts install ONE extension/power per repo from the repo ROOT; repo-root
    // registries (open-plugins) put their `marketplace.json` at the root too. Both are repo-level and
    // computed from EVERY plugin (the N=1 gate / registry membership sees the whole repo). The emit is
    // safety-guarded: bundling happens in temp (never against repoRoot), a single collision guard
    // refuses to overwrite non-generated root files (OP-D5), and orphan removal is bounded to the
    // prior tracked set recorded in the committed sidecar manifest. Merging the root registries into
    // the same tracked set (option (a)) unifies every repo-root file the toolkit owns.
    const priorTracked = readRootManifestPaths(repoRoot);
    const root = mergeRootArtifacts(
      computeRootArtifacts(repoRoot, registryPlugins, workspace),
      rootRegistryArtifactFiles(repoRoot, rootRegistries),
    );
    const { collidedOwners } = detectRootCollisions(repoRoot, root, priorTracked);

    // The tracked set is only the paths we actually WRITE — files of a collided (suppressed) owner
    // are neither written nor tracked, so orphan removal can never delete an author-owned collider.
    const writtenTracked = new Set<string>();
    const emittedOwners = new Set<TargetId>();
    for (const file of root.files) {
      if (collidedOwners.has(file.owner)) continue;
      const abs = path.join(repoRoot, ...file.relPath.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content);
      writtenTracked.add(file.relPath);
      emittedOwners.add(file.owner);
      for (const result of results) {
        result.artifacts.push({ path: abs, target: file.owner });
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
      // The sidecar spans every emitted owner (gemini/kiro/open-plugins), so it has no single
      // owning target — record it as `'shared'` rather than attributing it to one of the owners.
      // Only when something was emitted this run: when the manifest is being emptied via orphan
      // removal, nothing produced it this run, so it isn't recorded as an artifact.
      if (emittedOwners.size > 0) {
        for (const result of results) {
          result.artifacts.push({ path: manifestAbs, target: 'shared' });
        }
      }
    }
  }

  // Match standalone validation's freshness severity. The published-surface boundary check
  // belongs to standalone validate because it concerns contributor files outside the plugins.
  const validation = await runValidate(targetPath, {
    ci: Boolean(process.env['CI']),
    skipPublishedSurfaceBoundary: true,
    reportFreshnessIo: true,
  });
  if (opts?.failFast) {
    // Preserve the rejection criteria of post-build validation with freshness skipped.
    const hardFindings = validation.findings.filter(
      (f) => f.severity === 'hard' && f.code !== 'freshness' && f.code !== 'freshness-io',
    );
    if (hardFindings.length > 0) {
      const summary = hardFindings
        .map((f) => `  [${f.plugin ?? '?'}] ${f.code}: ${f.message}`)
        .join('\n');
      throw new Error(
        `Build produced ${String(hardFindings.length)} hard validation finding(s):\n${summary}`,
      );
    }
  }

  return { results, validation };
}
