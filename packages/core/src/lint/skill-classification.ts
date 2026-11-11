/**
 * Repo-wide skill classification for the published-surface boundary rules (L-D13).
 *
 * A repo that publishes plugins usually also holds skills meant only for its contributors, in the
 * hosts' project-local folders. The toolkit does not manage those — but install channels that find
 * `SKILL.md` files by walking the repository (the `skills` CLI) offer them to users anyway. This
 * module answers one question for the rules that guard that boundary: for every `SKILL.md` under
 * the repo root, is it **generated** (toolkit output), **published** (inside a discovered plugin),
 * or **unpublished** (anything else)?
 *
 * It deliberately knows nothing about *where* contributor skills live or which host loads them;
 * "unpublished" is defined purely as the complement of what the toolkit publishes or generates.
 *
 * @see docs/specs/lint-engine.md L-D13
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readRootManifestPaths } from '../pipeline/build.js';
import { discoverPlugins } from '../pipeline/discover.js';
import { hasRepoConfig, loadRepoConfig } from '../pipeline/load-config.js';
import type { RuleContext } from './types.js';

/** The file name that makes a directory a skill, per the Agent Skills convention. */
const SKILL_FILENAME = 'SKILL.md';

/**
 * Directory names never descended into by the filesystem fallback walk: dependency trees and VCS
 * internals hold other projects' skills (or none), never this repo's own authored content.
 */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** Which side of the published-surface boundary a `SKILL.md` falls on (L-D13). */
type SkillClass = 'generated' | 'published' | 'unpublished';

/** One classified `SKILL.md` under the repo root. */
export interface ClassifiedSkill {
  /** Absolute path to the `SKILL.md`. */
  absPath: string;
  /** Repo-relative, `/`-separated path — the form `Diagnostic.file` uses for repo-scoped rules. */
  relPath: string;
  /** The skill's class (L-D13). */
  skillClass: SkillClass;
  /**
   * The skill's identity as an install channel would key it: the frontmatter `name` when present,
   * else the name of the directory holding the `SKILL.md`.
   */
  name: string;
  /** True iff the frontmatter carries `metadata.internal` set to a value the `skills` CLI honors. */
  markedInternal: boolean;
}

/**
 * Values of `metadata.internal` that the `skills` CLI treats as "hide this skill". Matched exactly
 * so the rule's notion of "marked" never drifts looser or stricter than the channel it guards.
 *
 * @see https://github.com/vercel-labs/skills (isInternalSkill)
 */
function isInternalMarker(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/** True iff `value` is a non-null, non-array object (the only shape frontmatter keys live on). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert an absolute path under `repoRoot` to the repo-relative, `/`-separated form. */
function toRepoRel(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/**
 * List every `SKILL.md` under `repoRoot` using git's view of the work tree: tracked files plus
 * untracked files that are not ignored. This is what "the repository's content" means to an
 * install channel that clones the repo, and it is what keeps ignored trees (dependency installs,
 * build output, nested checkouts) out of the scan. Returns `undefined` when `repoRoot` is not
 * inside a git work tree or git is unavailable, so the caller can fall back to a filesystem walk.
 */
function listSkillFilesViaGit(repoRoot: string): string[] | undefined {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        `:(glob)**/${SKILL_FILENAME}`,
      ],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 },
    );
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (rel.length === 0) continue;
    const abs = path.join(repoRoot, ...rel.split('/'));
    // A tracked-but-deleted file is still listed by `--cached`; only files present on disk count.
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/**
 * Filesystem fallback for a repo root that is not a git work tree: walk every directory except
 * {@link WALK_SKIP_DIRS} and nested repositories (a subdirectory with its own `.git` entry is
 * someone else's checkout, not this repo's content).
 */
function listSkillFilesViaWalk(repoRoot: string): string[] {
  const out: string[] = [];
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        if (fs.existsSync(path.join(abs, '.git'))) continue;
        stack.push(abs);
      } else if (entry.isFile() && entry.name === SKILL_FILENAME) {
        out.push(abs);
      }
    }
  }
  return out;
}

/** True iff `child` is `parent` itself or lies inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Classify every `SKILL.md` under `ctx.repoRoot` (L-D13).
 *
 * Returns `undefined` when `ctx.repoRoot` is not an aipm repo root (no `aipm.repo.ts` and no
 * plugins root directory). That happens for single-plugin input whose "repo root" is only the
 * plugin's grandparent directory by convention: there is no published surface to guard there, and
 * walking an arbitrary ancestor directory would be both meaningless and unbounded.
 *
 * The published set is always discovered repo-wide, independent of which plugin(s) the current
 * run targets, so a single-plugin run inside a real repo classifies sibling plugins' skills
 * correctly instead of reporting them as unpublished.
 */
export async function classifyRepoSkills(ctx: RuleContext): Promise<ClassifiedSkill[] | undefined> {
  const { repoRoot } = ctx;

  let pluginDirs: string[];
  try {
    const repoConfig = await loadRepoConfig(repoRoot);
    const pluginsRootDir = path.join(repoRoot, repoConfig.pluginsRoot);
    const isRepoRoot =
      hasRepoConfig(repoRoot) ||
      (fs.existsSync(pluginsRootDir) && fs.statSync(pluginsRootDir).isDirectory());
    if (!isRepoRoot) return undefined;
    pluginDirs = (await discoverPlugins(repoRoot)).pluginDirs;
  } catch {
    // An unloadable `aipm.repo.ts` is reported by the repo-config check; without a usable
    // topology there is no published set to classify against.
    return undefined;
  }

  const generatedRootPaths = new Set(readRootManifestPaths(repoRoot));
  const skillFiles = listSkillFilesViaGit(repoRoot) ?? listSkillFilesViaWalk(repoRoot);

  const classified: ClassifiedSkill[] = [];
  for (const absPath of skillFiles) {
    const relPath = toRepoRel(repoRoot, absPath);

    let skillClass: SkillClass;
    if (isWithin(ctx.distDir, absPath) || generatedRootPaths.has(relPath)) {
      skillClass = 'generated';
    } else if (pluginDirs.some((pluginDir) => isWithin(pluginDir, absPath))) {
      skillClass = 'published';
    } else {
      skillClass = 'unpublished';
    }

    const frontmatter = ctx.getDocument(absPath)?.value;
    const record = isRecord(frontmatter) ? frontmatter : {};
    const declaredName = record['name'];
    const metadata = record['metadata'];
    classified.push({
      absPath,
      relPath,
      skillClass,
      name:
        typeof declaredName === 'string' && declaredName.length > 0
          ? declaredName
          : path.basename(path.dirname(absPath)),
      markedInternal: isRecord(metadata) && isInternalMarker(metadata['internal']),
    });
  }

  classified.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return classified;
}
