/**
 * Shared path-safety predicates for manifest path fields.
 *
 * Lives at `targets/` (not inside any single target folder) so any target validator may import it
 * without violating the cross-target-import rule (§3.4) — same status as `scaffold-kit.ts`.
 *
 * @see docs/specs/open-plugins-target.md §7 (traversal hardening)
 */

/**
 * Whether a manifest path contains a `..` parent-traversal SEGMENT. Splits on both `/` and `\` so
 * a Windows-style `..\` segment cannot slip past a `/`-only split, while a filename that merely
 * contains consecutive dots (e.g. `./my..config.json`) is NOT treated as traversal — `..` is only
 * dangerous as a whole path segment.
 */
export function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]/).includes('..');
}
