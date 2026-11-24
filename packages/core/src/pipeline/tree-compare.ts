/**
 * Comparing generated directory trees.
 *
 * A generated tree (a bundle, or a target's own tree) is checked by producing it again elsewhere
 * and comparing the two. This module owns what "the same tree" means, so the freshness check and
 * the ownership check of a per-target tree cannot disagree about it.
 *
 * @see docs/specs/architecture.md §10.5 (freshness), §5.2.1 (ownership of trees)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

/**
 * True iff the entries at `a` and `b`, which both exist, are the same: two links with the same
 * target as written, or two files with the same bytes and the same executable bits. A link is
 * compared as a link and never followed, since a tree keeps the plugin's links as the author wrote
 * them and one may name a directory.
 *
 * Of a file's permissions only the executable bits are compared: they are what a generated form
 * states (a change can set a file's mode, and trees carry scripts that are run directly) and what
 * version control preserves. The read and write bits vary with the environment that checked the
 * tree out.
 */
function sameTreeEntry(a: string, b: string): boolean {
  const aStat = fs.lstatSync(a);
  const bStat = fs.lstatSync(b);
  if (aStat.isSymbolicLink() || bStat.isSymbolicLink()) {
    return (
      aStat.isSymbolicLink() && bStat.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b)
    );
  }
  const EXECUTABLE_BITS = 0o111;
  if ((aStat.mode & EXECUTABLE_BITS) !== (bStat.mode & EXECUTABLE_BITS)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Compare two directory trees and return the relative paths that differ (present in only one
 * side, or present in both as different entries; see {@link sameTreeEntry}). An empty result means
 * the trees are identical.
 */
export function compareTrees(actualDir: string, expectedDir: string): string[] {
  const actual = new Set(collectFilesRelative(actualDir));
  const expected = new Set(collectFilesRelative(expectedDir));
  const drift = new Set<string>();

  for (const rel of actual) {
    if (!expected.has(rel)) {
      drift.add(rel);
      continue;
    }
    if (!sameTreeEntry(path.join(actualDir, rel), path.join(expectedDir, rel))) drift.add(rel);
  }
  for (const rel of expected) {
    if (!actual.has(rel)) drift.add(rel);
  }

  return [...drift].sort();
}
