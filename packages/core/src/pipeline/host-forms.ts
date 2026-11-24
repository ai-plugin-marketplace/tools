/**
 * Host forms: how one plugin's authored source becomes the form each target of its envelope
 * installs.
 *
 * Most of what a plugin's author writes is already what every target reads. Some authored
 * features are not: a skill's audience (`audience` and `audience-fallback` in `SKILL.md`
 * frontmatter) is stated once in the source and delivered differently per target, and the keys
 * themselves must not reach any of them. `@ai-plugin-marketplace/normalizer` decides what each
 * target's form is and describes it as a list of file changes against the authored source. This
 * module owns everything the pipeline does with that description:
 *
 * - {@link computePluginHostForms} asks the normalizer once per plugin and decides, per target,
 *   whether the target failed and where its form lives ({@link HostPlacement}). It changes
 *   nothing in the repository, so the build, the registries, the repo-root artifacts and the
 *   freshness check all work from the same answer.
 * - {@link HostFormsRun} holds that answer for one build, validation or lint run, so each plugin
 *   is projected once however many steps ask.
 * - {@link placeHostForm} is the single statement of the per-target output layout.
 * - {@link materializeHostForm}, {@link writeHostTree} and {@link applyHostFileChanges} produce a
 *   target's form on disk.
 * - The generated-trees manifest ({@link treeManifestPath}) records which per-target trees the
 *   toolkit wrote, so it only ever replaces, removes or reports directories of its own.
 *
 * What a feature means stays in the normalizer. The one thing this module reads from the source
 * itself is whether any skill states an audience at all, which decides how strictly findings about
 * the source are treated (see {@link computePluginHostForms}).
 *
 * @see docs/specs/architecture.md §5.2 (build phase), §10.5 (freshness)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  bundleGeminiPlugin,
  bundleKiroPlugin,
  projectPluginForHosts,
} from '@ai-plugin-marketplace/normalizer';
import type { HostFileChange } from '@ai-plugin-marketplace/normalizer';

import type { FeatureOutcome, Finding, TargetId } from './types.js';

/**
 * Where a target's form of a plugin lives.
 *
 * - `source` — the authored plugin directory. The target installs from it directly, and the
 *   registries list it. This is the case for every plugin whose source is already the target's
 *   form, and always for a target that can only install from the authored source (see
 *   {@link isSourceInstalledTarget}).
 * - `bundle` — the bundle the build always generates for the target under the dist root (Gemini,
 *   Kiro). When the target's form differs from the source, the differences are applied to the
 *   bundle.
 * - `tree` — a generated tree of the target's own under the dist root: a copy of the authored
 *   plugin directory with the differences applied. The registries list the tree instead of the
 *   source.
 * - `none` — the target failed. Nothing is emitted for it and no registry lists the plugin for it.
 *   A source-installed target cannot be withheld this way: whatever the build decides, it goes on
 *   installing the authored source.
 */
export type HostPlacement = 'source' | 'bundle' | 'tree' | 'none';

/**
 * The targets whose form is always a generated bundle, whether or not it differs from the source.
 * Every other target installs from the authored directory until its form differs.
 */
const BUNDLED_TARGETS: ReadonlySet<TargetId> = new Set<TargetId>(['gemini', 'kiro']);

/** True iff `target`'s form is always a generated bundle (see {@link HostPlacement}). */
export function isBundledTarget(target: TargetId): boolean {
  return BUNDLED_TARGETS.has(target);
}

/**
 * The targets that install a plugin's skills by scanning the authored source, with no registry
 * entry or bundle the build could point at a generated directory instead. Nothing generated for
 * such a target would ever be installed, so its form is the authored directory whatever the
 * projection says: no tree is built for it, and what the authored source cannot express there (a
 * restricted audience, for instance) is reported by the projection's findings.
 */
const SOURCE_INSTALLED_TARGETS: ReadonlySet<TargetId> = new Set<TargetId>(['vercel']);

/** True iff `target` can only install from the authored source (see {@link HostPlacement}). */
export function isSourceInstalledTarget(target: TargetId): boolean {
  return SOURCE_INSTALLED_TARGETS.has(target);
}

/**
 * The per-target output layout, stated once.
 *
 * A failed target gets nothing. A bundled target keeps its bundle. A source-installed target stays
 * on the authored directory. Any other target keeps installing from the authored directory for as
 * long as that directory is its form, and gets a tree of its own as soon as it is not.
 */
export function placeHostForm(
  target: TargetId,
  failed: boolean,
  changes: readonly HostFileChange[],
): HostPlacement {
  if (failed) return 'none';
  if (isBundledTarget(target)) return 'bundle';
  if (isSourceInstalledTarget(target)) return 'source';
  return changes.length === 0 ? 'source' : 'tree';
}

/**
 * True iff the build generates `form` from the authored source by applying its changes: a tree of
 * the target's own, or a bundle that differs from what the bundler alone produces. False for a
 * failed target and for one that installs from the authored directory, including a
 * source-installed target whose changes cannot be delivered.
 */
export function isProjectedForm(form: HostForm): boolean {
  return form.placement === 'tree' || (form.placement === 'bundle' && form.changes.length > 0);
}

/** How a plugin's authored source reaches one target of its envelope. */
export interface HostForm {
  /** The target. */
  target: TargetId;
  /** The unified content model's name for the target's host; absent where the model has none. */
  host?: string;
  /**
   * True iff the target's form cannot be built; {@link computePluginHostForms} lists the reasons.
   * A failed target's `changes` must not be applied.
   */
  failed: boolean;
  /** Where the target's form lives. */
  placement: HostPlacement;
  /**
   * The changes that turn the authored source into this target's form, in the order to apply
   * them. Empty when the source is already the form. They are applied only where the build
   * generates the form (see {@link isProjectedForm}); a source-installed target keeps them here as
   * the description of what it does not receive.
   */
  changes: readonly HostFileChange[];
  /** One outcome per authored feature and subject on this target. */
  outcomes: FeatureOutcome[];
  /** Every finding about this target. */
  findings: Finding[];
}

/** The host forms of one plugin: one per target of its envelope, plus findings about the source. */
export interface PluginHostForms {
  /**
   * Findings about the authored source itself, whatever the target. A `hard` one means no target
   * can be built, so every {@link HostForm} is then `failed`.
   */
  sourceFindings: Finding[];
  /** One entry per target, in envelope order. */
  hosts: HostForm[];
}

// ---------------------------------------------------------------------------
// The generated-trees manifest
// ---------------------------------------------------------------------------

/** Repo-root-relative path of the manifest that records the per-target trees the toolkit wrote. */
const TREE_MANIFEST_REL = ['.aipm', 'generated-trees.json'] as const;

/**
 * Absolute path of the generated-trees manifest under `repoRoot`.
 *
 * The manifest lists, as repo-root-relative POSIX paths, every per-target tree a build wrote. It
 * is what lets the toolkit tell a tree of its own from a directory an author put at the same path:
 * a build replaces or removes only listed directories, and the freshness check reports only those.
 * A target's tree path that is occupied by an unlisted directory fails that target instead of
 * being overwritten. Bundles of the always-bundled targets are not listed; their directories have
 * always been wholly generated.
 */
export function treeManifestPath(repoRoot: string): string {
  return path.join(repoRoot, ...TREE_MANIFEST_REL);
}

/** How the manifest names the tree at `dir`: its path from the repo root, POSIX-separated. */
export function treeManifestEntry(repoRoot: string, dir: string): string {
  return path.relative(repoRoot, dir).split(path.sep).join('/');
}

/**
 * The bytes of a generated-trees manifest listing `entries`: `{ version: 1, paths }` with the
 * paths deduplicated and sorted, 2-space JSON and a trailing newline, so the same set always
 * serializes identically.
 */
export function serializeTreeManifest(entries: Iterable<string>): string {
  return `${JSON.stringify({ version: 1, paths: [...new Set(entries)].sort() }, null, 2)}\n`;
}

/**
 * The trees the manifest under `repoRoot` lists. A missing or unreadable manifest lists nothing:
 * the toolkit then owns no tree, and an existing directory at a tree's path is left alone.
 */
export function readTrackedTrees(repoRoot: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(treeManifestPath(repoRoot), 'utf-8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'paths' in parsed) {
      const { paths } = parsed as { paths: unknown };
      if (Array.isArray(paths)) {
        return new Set(paths.filter((p): p is string => typeof p === 'string'));
      }
    }
  } catch {
    // Absent or corrupt: nothing is tracked.
  }
  return new Set();
}

// ---------------------------------------------------------------------------
// Computing host forms
// ---------------------------------------------------------------------------

/**
 * Where a repository keeps what host forms are placed against: its root, its dist root, and the
 * per-target trees the toolkit is recorded as having written there.
 */
export interface HostFormsLayout {
  /** Absolute repo root. */
  repoRoot: string;
  /** Absolute dist root. */
  distDir: string;
  /** The generated-trees manifest's entries as they were when the run began. */
  trackedTrees: ReadonlySet<string>;
}

/**
 * The host forms of every plugin asked about during one build, validation or lint run.
 *
 * A plugin is projected the first time it is asked about and the answer is reused for the rest of
 * the run, so every step of a run sees one consistent set of forms, computed against the manifest
 * as it stood when the run began. A run must not outlive changes to the authored source.
 */
export interface HostFormsRun {
  /** The repository layout the forms are placed against. */
  readonly layout: HostFormsLayout;
  /** The host forms of the plugin at `pluginDir` for the targets in `envelope`. */
  forms(pluginDir: string, envelope: readonly TargetId[]): PluginHostForms;
}

/** Start a {@link HostFormsRun} for the repository at `repoRoot`, reading its manifest once. */
export function createHostFormsRun(repoRoot: string, distDir: string): HostFormsRun {
  const layout: HostFormsLayout = { repoRoot, distDir, trackedTrees: readTrackedTrees(repoRoot) };
  const memo = new Map<string, PluginHostForms>();
  return {
    layout,
    forms(pluginDir, envelope) {
      const key = `${path.resolve(pluginDir)}\0${envelope.join(',')}`;
      let forms = memo.get(key);
      if (forms === undefined) {
        forms = computePluginHostForms(pluginDir, envelope, layout);
        memo.set(key, forms);
      }
      return forms;
    },
  };
}

/** Matches a frontmatter line that states one of the two source-only audience keys. */
const AUDIENCE_KEY_LINE = /^[ \t]*["']?audience(?:-fallback)?["']?[ \t]*:/m;

/**
 * True iff any `SKILL.md` under `pluginDir` states `audience` or `audience-fallback`.
 *
 * This is deliberately a reading of its own rather than the projection's: it must answer for the
 * very files the projection could not use (a linked `SKILL.md`, a skill directory linked from
 * outside the plugin, malformed frontmatter), which is where the answer decides how strictly their
 * findings are treated. Links are followed. Only the frontmatter block is searched, or the whole
 * file when the block is not closed; a file that cannot be read states nothing.
 */
function sourceStatesAudience(pluginDir: string): boolean {
  const visited = new Set<string>();
  const walk = (dir: string): boolean => {
    let real: string;
    let entries: string[];
    try {
      real = fs.realpathSync(dir);
      if (visited.has(real)) return false;
      visited.add(real);
      entries = fs.readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (TREE_SKIP_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs, { throwIfNoEntry: false });
      if (stat === undefined) continue; // a dangling link
      if (stat.isDirectory()) {
        if (walk(abs)) return true;
      } else if (name === 'SKILL.md' && stat.isFile()) {
        let text: string;
        try {
          text = fs.readFileSync(abs, 'utf-8');
        } catch {
          continue;
        }
        const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
        if (AUDIENCE_KEY_LINE.test(block?.[1] ?? text)) return true;
      }
    }
    return false;
  };
  return walk(pluginDir);
}

/**
 * Compute how a plugin reaches each target of its envelope, **without changing the repository**.
 *
 * The single source of truth for which targets failed, where each target's form lives and what
 * changes produce it. `runBuild` writes from it; registry generation, the repo-root artifacts and
 * the freshness check derive their expectations from it, so they cannot disagree with the build.
 * Callers inside a run go through {@link HostFormsRun} rather than calling this again.
 *
 * A target fails when:
 *
 * - the source has a `hard` finding and the plugin states an audience (see below);
 * - the target has a `hard` finding of its own;
 * - its changes cannot be applied (each generated form is produced once in a scratch directory to
 *   find out, so a build never discovers this halfway through writing);
 * - its tree's path is occupied by a directory the toolkit did not write (`layout` given).
 *
 * The last two are reported as `hard` findings of that target.
 *
 * **A plugin that states no audience builds as it always has.** When no skill states `audience`
 * or `audience-fallback` and no target has changes, nothing the projection reads can alter the
 * output: every target's form is the authored source. Problems it finds in the source (a skill it
 * cannot read safely, two skills of one name) are then reported as `soft` findings and fail no
 * target. Once any skill states an audience they are `hard`, since an unreadable skill may be one
 * whose restriction would be lost.
 *
 * @param pluginDir - Absolute path of the authored plugin directory.
 * @param envelope - The plugin's declared targets.
 * @param layout - The repository layout, when known. Without it no tree path is checked for
 *   ownership.
 * @throws {Error} If the normalizer cannot project the plugin at all (for example `pluginDir` is
 *   not a directory). Problems with the authored content are findings, not errors.
 */
export function computePluginHostForms(
  pluginDir: string,
  envelope: readonly TargetId[],
  layout?: HostFormsLayout,
): PluginHostForms {
  const pluginName = path.basename(pluginDir);
  const projection = projectPluginForHosts({
    pluginDir,
    targets: envelope,
    plugin: pluginName,
  });

  const statesAudience =
    projection.hosts.some((host) => host.changes.length > 0) || sourceStatesAudience(pluginDir);
  const sourceFindings: Finding[] = projection.findings.map((f) =>
    statesAudience || f.severity !== 'hard' ? { ...f } : { ...f, severity: 'soft' },
  );
  const sourceFailed = sourceFindings.some((f) => f.severity === 'hard');

  const hosts = projection.hosts.map((host): HostForm => {
    const findings: Finding[] = [...host.findings];
    let failed = sourceFailed || findings.some((f) => f.severity === 'hard');
    const fail = (finding: Finding): void => {
      findings.push(finding);
      failed = true;
    };

    if (!failed && placeHostForm(host.target, false, host.changes) === 'tree' && layout) {
      const dir = hostDistDir(layout.distDir, host.target, pluginName);
      const entry = treeManifestEntry(layout.repoRoot, dir);
      if (fs.existsSync(dir) && !layout.trackedTrees.has(entry)) {
        fail({
          severity: 'hard',
          code: 'generated-tree-collision',
          plugin: pluginName,
          message:
            `Cannot write the '${host.target}' form of the plugin: '${entry}' already exists and is not toolkit-generated. ` +
            `Generation refuses to overwrite a directory it does not own.`,
          hint: `Move or remove '${entry}' and re-run \`aipm build\`.`,
        });
      }
    }

    if (!failed && host.changes.length > 0 && !isSourceInstalledTarget(host.target)) {
      const problem = tryMaterializeHostForm(
        pluginDir,
        host.target,
        host.changes,
        layout?.distDir ?? path.join(pluginDir, 'dist'),
      );
      if (problem !== undefined) {
        fail({
          severity: 'hard',
          code: 'source-unreadable',
          plugin: pluginName,
          message: `The '${host.target}' form of the plugin cannot be produced: ${problem}`,
          hint: 'Fix the plugin source named in the message, then re-run `aipm build`.',
        });
      }
    }

    // One line per distinct outcome: skills that share a name would otherwise repeat theirs.
    const seen = new Set<string>();
    const outcomes: FeatureOutcome[] = [];
    for (const o of host.outcomes) {
      const key = JSON.stringify([o.feature, o.subject, o.implementation, o.fidelity]);
      if (seen.has(key)) continue;
      seen.add(key);
      outcomes.push({
        feature: o.feature,
        subject: o.subject,
        implementation: o.implementation,
        fidelity: [...o.fidelity],
      });
    }

    return {
      target: host.target,
      ...(host.host !== undefined ? { host: host.host } : {}),
      failed,
      placement: placeHostForm(host.target, failed, host.changes),
      changes: host.changes,
      outcomes,
      findings,
    };
  });

  return { sourceFindings, hosts };
}

/** The form of `target` in `forms`, or `undefined` when the target is not in the envelope. */
export function hostFormFor(forms: PluginHostForms, target: TargetId): HostForm | undefined {
  return forms.hosts.find((h) => h.target === target);
}

/**
 * The directory under the dist root that holds a target's generated form of a plugin:
 * `<dist>/<target>/<plugin>`. Bundles and per-target trees share the layout.
 */
export function hostDistDir(distDir: string, target: TargetId, pluginName: string): string {
  return path.join(distDir, target, pluginName);
}

/**
 * The directory a target's form of a plugin is installed from, or `undefined` for a failed
 * target: the authored directory, or the target's directory under the dist root.
 */
export function hostFormDir(
  pluginDir: string,
  distDir: string,
  form: HostForm,
): string | undefined {
  switch (form.placement) {
    case 'none':
      return undefined;
    case 'source':
      return pluginDir;
    case 'bundle':
    case 'tree':
      return hostDistDir(distDir, form.target, path.basename(pluginDir));
  }
}

/**
 * Directory names never copied into a target's tree: dependency trees and version-control
 * internals are not part of what an author publishes, and a host installing from the authored
 * directory never receives them either (they are not committed).
 */
const TREE_SKIP_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * Lay down what a target's changes apply to, at `into` (cleared first): the target's bundle for an
 * always-bundled target, a copy of the authored plugin directory for any other. The bundlers copy
 * the parts of the plugin that changes address to the same relative paths, so one list of changes
 * applies to either.
 */
function writeHostFormBase(
  pluginDir: string,
  target: TargetId,
  into: string,
  excludeDir: string,
): void {
  if (target === 'gemini') {
    bundleGeminiPlugin(pluginDir, into);
  } else if (target === 'kiro') {
    bundleKiroPlugin(pluginDir, into);
  } else {
    copyPluginTree(pluginDir, into, excludeDir);
  }
}

/**
 * Produce a target's generated form of a plugin at `into`, replacing whatever is there: its
 * bundle or a copy of the plugin directory, with the target's changes applied in order.
 *
 * @param excludeDir - Absolute path of a directory never to copy from (the dist root).
 * @throws {Error} If a change cannot be applied; see {@link applyHostFileChanges}. `into` is then
 *   left partly written.
 */
export function materializeHostForm(
  pluginDir: string,
  target: TargetId,
  changes: readonly HostFileChange[],
  into: string,
  excludeDir: string,
): void {
  writeHostFormBase(pluginDir, target, into, excludeDir);
  applyHostFileChanges(into, changes);
}

/**
 * Find out whether a target's changes can be applied, by producing its form in a scratch directory
 * that is removed again. Returns the reason they cannot, or `undefined` when they can.
 *
 * Only applying the changes is in question here: a failure to lay down the bundle or the copy is
 * not about this target's changes and propagates as the error it is.
 */
function tryMaterializeHostForm(
  pluginDir: string,
  target: TargetId,
  changes: readonly HostFileChange[],
  excludeDir: string,
): string | undefined {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-host-form-'));
  try {
    const into = path.join(scratch, path.basename(pluginDir));
    writeHostFormBase(pluginDir, target, into, excludeDir);
    try {
      applyHostFileChanges(into, changes);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return undefined;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Write a target's own tree: clear `into`, copy the authored plugin directory there, then apply
 * the target's changes.
 *
 * The copy is everything under `pluginDir` except `node_modules`, `.git` and anything under
 * `excludeDir` (the dist root, should a layout ever place it inside the plugin). Links are kept
 * as written, so a relative link inside the plugin still resolves inside the copy.
 *
 * @param pluginDir - Absolute path of the authored plugin directory.
 * @param into - Absolute path of the tree to (re)create.
 * @param changes - The target's changes, applied in order.
 * @param excludeDir - Absolute path of a directory never to copy from.
 */
export function writeHostTree(
  pluginDir: string,
  into: string,
  changes: readonly HostFileChange[],
  excludeDir: string,
): void {
  copyPluginTree(pluginDir, into, excludeDir);
  applyHostFileChanges(into, changes);
}

/** Replace `into` with a copy of the authored plugin directory; see {@link writeHostTree}. */
function copyPluginTree(pluginDir: string, into: string, excludeDir: string): void {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(into), { recursive: true });
  const excluded = path.resolve(excludeDir);
  fs.cpSync(pluginDir, into, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      if (TREE_SKIP_NAMES.has(path.basename(src))) return false;
      const resolved = path.resolve(src);
      return resolved !== excluded && !resolved.startsWith(`${excluded}${path.sep}`);
    },
  });
}

/** True iff `candidate` is `root` or lies under it. Both must be absolute and normalized. */
function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve a change's path against the tree it applies to, refusing one that would leave the tree.
 * Change paths are relative and forward-slashed by contract; this guards the tree's boundary
 * rather than trusting that.
 *
 * The boundary is checked twice: as written, and as the filesystem resolves it. A tree keeps the
 * plugin's links as the author wrote them, so a directory on the path may be a link to somewhere
 * else (an absolute link back into the authored plugin, for instance); a change applied through it
 * would modify what the link points at instead of the tree. The entry the path names may itself be
 * a link (removing or moving a link acts on the link), so only the directories leading to it are
 * resolved here; {@link applyHostFileChanges} checks the entry where it writes through it.
 */
function resolveInTree(rootDir: string, relPath: string): string {
  const abs = path.resolve(rootDir, ...relPath.split('/'));
  const root = path.resolve(rootDir);
  if (relPath === '' || path.isAbsolute(relPath) || !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Host file change names a path outside the plugin: '${relPath}'.`);
  }
  let existingParent = path.dirname(abs);
  while (!fs.existsSync(existingParent) && existingParent !== root) {
    existingParent = path.dirname(existingParent);
  }
  assertResolvesInTree(root, existingParent, relPath);
  return abs;
}

/**
 * Throw unless `abs`, which must exist, resolves (links followed) to a place inside the tree at
 * `root`.
 */
function assertResolvesInTree(root: string, abs: string, relPath: string): void {
  if (!isWithin(fs.realpathSync(root), fs.realpathSync(abs))) {
    throw new Error(
      `Host file change '${relPath}' reaches outside the plugin through a link; ` +
        `links inside a plugin must be relative and stay inside it.`,
    );
  }
}

/**
 * Apply a target's changes to a copy of the plugin, one after another, each to the result of the
 * one before.
 *
 * - `write` creates the file or replaces its content, creating missing parent directories, and
 *   sets its permission bits when the change states them.
 * - `remove` deletes the file or the directory subtree, which must exist.
 * - `move` relocates the file or directory to a destination that must not exist.
 *
 * The preconditions are enforced rather than tolerated: a change that does not fit the tree means
 * the tree is not the one the changes were computed for, and applying the rest would produce a
 * form that silently differs from the described one. A change of an unknown kind is refused for
 * the same reason.
 *
 * @throws {Error} If a path leaves `rootDir` (as written, or through a link), a precondition does
 *   not hold, or a change's kind is not one of the three above.
 */
export function applyHostFileChanges(rootDir: string, changes: readonly HostFileChange[]): void {
  for (const change of changes) {
    switch (change.kind) {
      case 'write': {
        const abs = resolveInTree(rootDir, change.path);
        // Writing follows a link at the path itself, so what it leads to must be in the tree. A
        // link that leads nowhere is refused outright: the write would create its target, wherever
        // that is.
        if (fs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
          if (!fs.existsSync(abs)) {
            throw new Error(
              `Host file change '${change.path}' writes through a link that leads nowhere; ` +
                `links inside a plugin must be relative and stay inside it.`,
            );
          }
          assertResolvesInTree(path.resolve(rootDir), abs, change.path);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, change.content, 'utf-8');
        // `writeFileSync`'s mode only applies when it creates the file; set it explicitly so a
        // replaced file gets the stated bits too.
        if (change.mode !== undefined) fs.chmodSync(abs, change.mode);
        break;
      }
      case 'remove': {
        const abs = resolveInTree(rootDir, change.path);
        if (fs.lstatSync(abs, { throwIfNoEntry: false }) === undefined) {
          throw new Error(`Host file change removes '${change.path}', which does not exist.`);
        }
        fs.rmSync(abs, { recursive: true });
        break;
      }
      case 'move': {
        const from = resolveInTree(rootDir, change.from);
        const to = resolveInTree(rootDir, change.to);
        if (fs.lstatSync(from, { throwIfNoEntry: false }) === undefined) {
          throw new Error(`Host file change moves '${change.from}', which does not exist.`);
        }
        if (fs.lstatSync(to, { throwIfNoEntry: false }) !== undefined) {
          throw new Error(
            `Host file change moves '${change.from}' onto '${change.to}', which already exists.`,
          );
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        break;
      }
      default: {
        const unknown: never = change;
        throw new Error(
          `Unknown host file change kind: ${JSON.stringify((unknown as { kind?: unknown }).kind)}.`,
        );
      }
    }
  }
}
