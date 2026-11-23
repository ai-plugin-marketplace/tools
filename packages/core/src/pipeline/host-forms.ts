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
 *   whether the target failed and where its form lives ({@link HostPlacement}). It reads the
 *   source and writes nothing, so the build, the registries, the repo-root artifacts and the
 *   freshness check all work from the same answer.
 * - {@link placeHostForm} is the single statement of the per-target output layout.
 * - {@link writeHostTree} and {@link applyHostFileChanges} produce a target's form on disk.
 *
 * Nothing here knows what any one feature means; that stays in the normalizer.
 *
 * @see docs/specs/architecture.md §5.2 (build phase), §10.5 (freshness)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectPluginForHosts } from '@ai-plugin-marketplace/normalizer';
import type { HostFileChange } from '@ai-plugin-marketplace/normalizer';

import type { FeatureOutcome, Finding, TargetId } from './types.js';

/**
 * Where a target's form of a plugin lives.
 *
 * - `source` — the authored plugin directory. The target installs from it directly, and the
 *   registries list it. This is the case for every plugin whose source is already the target's
 *   form.
 * - `bundle` — the bundle the build always generates for the target under the dist root (Gemini,
 *   Kiro). When the target's form differs from the source, the differences are applied to the
 *   bundle.
 * - `tree` — a generated tree of the target's own under the dist root: a copy of the authored
 *   plugin directory with the differences applied. The registries list the tree instead of the
 *   source.
 * - `none` — the target failed. Nothing is emitted for it and no registry lists the plugin for it.
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
 * The per-target output layout, stated once.
 *
 * A failed target gets nothing. A bundled target keeps its bundle. Any other target keeps
 * installing from the authored directory for as long as that directory is its form, and gets a
 * tree of its own as soon as it is not.
 */
export function placeHostForm(
  target: TargetId,
  failed: boolean,
  changes: readonly HostFileChange[],
): HostPlacement {
  if (failed) return 'none';
  if (isBundledTarget(target)) return 'bundle';
  return changes.length === 0 ? 'source' : 'tree';
}

/** How a plugin's authored source reaches one target of its envelope. */
export interface HostForm {
  /** The target. */
  target: TargetId;
  /** The unified content model's name for the target's host; absent where the model has none. */
  host?: string;
  /**
   * True iff the target's form cannot be built: the source has a `hard` finding of its own, or
   * this target has one. A failed target's `changes` must not be applied.
   */
  failed: boolean;
  /** Where the target's form lives. */
  placement: HostPlacement;
  /**
   * The changes that turn the authored source into this target's form, in the order to apply
   * them. Empty when the source is already the form.
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

/**
 * Compute how a plugin reaches each target of its envelope, **without writing**.
 *
 * The single source of truth for which targets failed, where each target's form lives and what
 * changes produce it. `runBuild` writes from it; registry generation, the repo-root artifacts and
 * the freshness check derive their expectations from it, so they cannot disagree with the build.
 *
 * @param pluginDir - Absolute path of the authored plugin directory.
 * @param envelope - The plugin's declared targets.
 * @throws {Error} If the normalizer cannot project the plugin at all (for example `pluginDir` is
 *   not a directory). Problems with the authored content are findings, not errors.
 */
export function computePluginHostForms(
  pluginDir: string,
  envelope: readonly TargetId[],
): PluginHostForms {
  const projection = projectPluginForHosts({
    pluginDir,
    targets: envelope,
    plugin: path.basename(pluginDir),
  });

  const sourceFindings: Finding[] = [...projection.findings];
  const sourceFailed = sourceFindings.some((f) => f.severity === 'hard');

  const hosts = projection.hosts.map((host): HostForm => {
    const findings: Finding[] = [...host.findings];
    const failed = sourceFailed || findings.some((f) => f.severity === 'hard');
    return {
      target: host.target,
      ...(host.host !== undefined ? { host: host.host } : {}),
      failed,
      placement: placeHostForm(host.target, failed, host.changes),
      changes: host.changes,
      outcomes: host.outcomes.map((o) => ({
        feature: o.feature,
        subject: o.subject,
        implementation: o.implementation,
        fidelity: [...o.fidelity],
      })),
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
  applyHostFileChanges(into, changes);
}

/**
 * Resolve a change's path against the tree it applies to, refusing one that would leave the tree.
 * Change paths are relative and forward-slashed by contract; this guards the tree's boundary
 * rather than trusting that.
 */
function resolveInTree(rootDir: string, relPath: string): string {
  const abs = path.resolve(rootDir, ...relPath.split('/'));
  const root = path.resolve(rootDir);
  if (relPath === '' || path.isAbsolute(relPath) || !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Host file change names a path outside the plugin: '${relPath}'.`);
  }
  return abs;
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
 * @throws {Error} If a path leaves `rootDir`, a precondition does not hold, or a change's kind is
 *   not one of the three above.
 */
export function applyHostFileChanges(rootDir: string, changes: readonly HostFileChange[]): void {
  for (const change of changes) {
    switch (change.kind) {
      case 'write': {
        const abs = resolveInTree(rootDir, change.path);
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
