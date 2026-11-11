/**
 * Repo-wide skill classification for the published-surface boundary rules (L-D13).
 *
 * A repo that publishes plugins usually also holds skills meant only for its contributors, in the
 * hosts' project-local folders. The toolkit does not manage those — but install channels that find
 * `SKILL.md` files by walking the repository (the `skills` CLI) offer them to users anyway. This
 * module answers one question for the rules that guard that boundary: for every `SKILL.md` under
 * the repo root, is it **generated** (toolkit output), **published** (inside a discovered plugin),
 * **installed** (third-party content the `skills` CLI itself placed there), or **unpublished**
 * (anything else)?
 *
 * The scan is deliberately broader than any one channel's discovery: it considers every `SKILL.md`
 * in the repository, not only the folders and depths the `skills` CLI happens to search today, so
 * the answer does not shift when a channel changes its search rules.
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

/**
 * The file name that makes a directory a skill, per the Agent Skills convention. Matched without
 * regard to case: install channels resolve it case-insensitively (always when reading a remote
 * repository tree, and on case-insensitive filesystems locally), so `skill.md` is just as
 * installable as `SKILL.md`.
 */
const SKILL_FILENAME = 'SKILL.md';

/** True iff `fileName` names a skill file, ignoring case. */
function isSkillFileName(fileName: string): boolean {
  return fileName.toLowerCase() === SKILL_FILENAME.toLowerCase();
}

/**
 * The lock file the `skills` CLI writes at a project root to record skills it installed there.
 *
 * @see https://github.com/vercel-labs/skills (skills-lock.json)
 */
const SKILLS_LOCK_FILENAME = 'skills-lock.json';

/**
 * Directory names whose contents are never this repo's own authored content: dependency trees and
 * VCS internals hold other projects' skills (or none). Excluded from both enumeration strategies,
 * so a repository that commits (or simply does not ignore) `node_modules` is treated the same as
 * one that ignores it.
 */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** Which side of the published-surface boundary a `SKILL.md` falls on (L-D13). */
type SkillClass = 'generated' | 'published' | 'installed' | 'unpublished';

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
        `:(glob,icase)**/${SKILL_FILENAME}`,
      ],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 },
    );
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (rel.length === 0) continue;
    const segments = rel.split('/');
    if (segments.some((segment) => WALK_SKIP_DIRS.has(segment))) continue;
    const abs = path.join(repoRoot, ...segments);
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
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isSkillFileName(entry.name)) {
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

/** Resolve symlinks in `p`, or return `undefined` when it cannot be resolved (a dangling link). */
function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a skill name the way the `skills` CLI does when it compares a discovered skill against
 * its lock file, so "installed" is decided by the same identity the CLI uses.
 */
function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * The normalized names of skills the `skills` CLI recorded as installed into this repository, read
 * from the repo-root lock file. Empty when there is no lock file or it is not a lock-shaped object
 * (the CLI itself treats an invalid lock as "nothing locked").
 */
function readInstalledSkillNames(repoRoot: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, SKILLS_LOCK_FILENAME), 'utf-8'));
  } catch {
    return new Set();
  }
  if (!isRecord(parsed) || typeof parsed['version'] !== 'number') return new Set();
  const skills = parsed['skills'];
  if (!isRecord(skills)) return new Set();
  return new Set(Object.keys(skills).map(normalizeSkillName));
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
  const installedNames = readInstalledSkillNames(repoRoot);
  const skillFiles = listSkillFilesViaGit(repoRoot) ?? listSkillFilesViaWalk(repoRoot);

  // Containment is decided on resolved paths, so a symlinked plugins root, dist root, or skill
  // file is classified by where the content really lives.
  const realDistDir = realpathOrUndefined(ctx.distDir) ?? ctx.distDir;
  const realPluginDirs = pluginDirs.map((dir) => realpathOrUndefined(dir) ?? dir);
  const realRepoRoot = realpathOrUndefined(repoRoot) ?? repoRoot;

  // Resolve every entry once. `direct` is true when the entry is the file itself rather than a
  // symlink to it — i.e. its resolved path is exactly where its repo-relative path says it is.
  const entries = skillFiles.map((absPath) => {
    const relPath = toRepoRel(repoRoot, absPath);
    const realPath = realpathOrUndefined(absPath);
    const direct = realPath === path.join(realRepoRoot, ...relPath.split('/'));
    return { absPath, relPath, realPath, direct };
  });
  const directRealPaths = new Set(
    entries.flatMap((entry) =>
      entry.direct && entry.realPath !== undefined ? [entry.realPath] : [],
    ),
  );

  const classified: ClassifiedSkill[] = [];
  for (const { absPath, relPath, realPath, direct } of entries) {
    // A dangling symlink has no content for any channel to install.
    if (realPath === undefined) continue;
    // An alias (a symlink whose target is itself enumerated) is the same skill reached by a second
    // path — typically a project-local link to a published skill so contributors get it too. The
    // target's own entry carries the classification; reporting the alias as well would demand a
    // marker on a file that is really the published one.
    if (!direct && directRealPaths.has(realPath)) continue;

    const frontmatter = ctx.getDocument(absPath)?.value;
    const record = isRecord(frontmatter) ? frontmatter : {};
    const declaredName = record['name'];
    const metadata = record['metadata'];
    const dirName = path.basename(path.dirname(absPath));
    const name =
      typeof declaredName === 'string' && declaredName.length > 0 ? declaredName : dirName;

    let skillClass: SkillClass;
    if (isWithin(realDistDir, realPath) || generatedRootPaths.has(relPath)) {
      skillClass = 'generated';
    } else if (realPluginDirs.some((pluginDir) => isWithin(pluginDir, realPath))) {
      skillClass = 'published';
    } else if (
      // Mirrors the `skills` CLI's own exclusion: a skill in a host's project-local (dot) folder
      // whose name or directory the lock file records was installed from elsewhere. The CLI does
      // not offer it, and its content is vendored, so it is neither this repo's to publish nor to
      // edit.
      relPath.startsWith('.') &&
      (installedNames.has(normalizeSkillName(name)) ||
        installedNames.has(normalizeSkillName(dirName)))
    ) {
      skillClass = 'installed';
    } else {
      skillClass = 'unpublished';
    }

    classified.push({
      absPath,
      relPath,
      skillClass,
      name,
      markedInternal: isRecord(metadata) && isInternalMarker(metadata['internal']),
    });
  }

  classified.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return classified;
}
