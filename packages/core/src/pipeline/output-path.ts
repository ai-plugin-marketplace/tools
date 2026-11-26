import * as fs from 'node:fs';
import * as path from 'node:path';

interface PathEntry {
  path: string;
  identity: string;
  stat: fs.Stats | undefined;
  inheritedCaseInsensitivity: boolean;
}

export interface OutputPath {
  path: string;
  /** Directory entry affected by unlink or recursive removal. */
  entry: PathEntry;
  /** Destination affected by writing through links. */
  destination: PathEntry;
  /** Links traversed in order, including links encountered inside other links' targets. */
  links: PathEntry[];
  blockedBy?: string;
}

export function containsPath(directory: string, candidate: string): boolean {
  const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
  return candidate === directory || candidate.startsWith(prefix);
}

export function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

/** Resolve path identities before writing, including missing entries and paths through symlinks. */
export class OutputPathResolver {
  private readonly caseInsensitive = new Map<string, boolean>();

  private ignoresCase(directory: PathEntry, name: string, stat: fs.Stats | undefined): boolean {
    const cached = this.caseInsensitive.get(directory.path);
    if (cached !== undefined) return cached;

    const alternate = name.replace(/[a-z]/i, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    );
    // Probe a known child by name. This needs search permission, even when the directory
    // cannot be listed. Without a known child to probe, inherit the parent's behavior.
    if (alternate === name || stat === undefined) return directory.inheritedCaseInsensitivity;
    const other = fs.lstatSync(path.join(directory.path, alternate), { throwIfNoEntry: false });
    const insensitive = other?.dev === stat.dev && other.ino === stat.ino;
    if (insensitive && !stat.isDirectory() && stat.nlink > 1) {
      // The alternate may be another hard link. It cannot establish the directory's case policy.
      return directory.inheritedCaseInsensitivity;
    }
    this.caseInsensitive.set(directory.path, insensitive);
    return insensitive;
  }

  locate(absPath: string, followLeaf = true): OutputPath {
    const links: PathEntry[] = [];
    let blockedBy: string | undefined;
    const root = (rootPath: string): PathEntry => ({
      path: rootPath,
      identity: process.platform === 'win32' ? rootPath.toLowerCase() : rootPath,
      stat: fs.lstatSync(rootPath, { throwIfNoEntry: false }),
      inheritedCaseInsensitivity: process.platform === 'win32',
    });

    const walk = (start: PathEntry, suffix: string, followLast: boolean): OutputPath => {
      const segments = suffix
        .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
        .filter(Boolean);
      let parent = start;
      let entry = start;
      for (const [index, name] of segments.entries()) {
        if (name === '.') continue;
        if (name === '..') {
          // The parent already resolves physically, so walking its parent introduces no links.
          const upper = this.locate(path.dirname(parent.path)).destination;
          parent = upper;
          entry = upper;
          continue;
        }

        const directory = parent;
        const entryPath = path.join(directory.path, name);
        if (parent.stat !== undefined && !parent.stat.isDirectory()) {
          blockedBy ??= parent.path;
        }
        const stat =
          blockedBy === undefined ? fs.lstatSync(entryPath, { throwIfNoEntry: false }) : undefined;
        const parentIgnoresCase = this.ignoresCase(parent, name, stat);
        entry = {
          path: entryPath,
          identity: path.join(parent.identity, parentIgnoresCase ? name.toLowerCase() : name),
          stat,
          inheritedCaseInsensitivity: parentIgnoresCase,
        };
        parent = entry;
        if (stat?.isSymbolicLink() && (followLast || index < segments.length - 1)) {
          links.push(entry);
          if (links.length > 40) throw new Error("Too many symlinks resolving '" + absPath + "'.");
          const target = fs.readlinkSync(entryPath);
          const targetRoot = path.parse(target).root;
          const targetStart = path.isAbsolute(target) ? root(targetRoot) : directory;
          parent = walk(targetStart, target.slice(targetRoot.length), true).destination;
        }
      }
      return {
        path: absPath,
        entry,
        destination: parent,
        links,
        ...(blockedBy === undefined ? {} : { blockedBy }),
      };
    };

    const rootPath = path.parse(absPath).root;
    return walk(root(rootPath), absPath.slice(rootPath.length), followLeaf);
  }
}
