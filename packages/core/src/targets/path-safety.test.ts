/**
 * Tests for the shared path-safety predicates.
 *
 * Regression (PR #30 review): the traversal guards used a substring `includes('..')`, which falsely
 * rejected filenames merely containing consecutive dots (e.g. `./my..config.json`). Traversal is a
 * whole `..` path SEGMENT — split on both `/` and `\` so a Windows-style `..\` cannot slip through.
 *
 * @see docs/specs/open-plugins-target.md §7 (traversal hardening)
 */

import { describe, expect, it } from 'vitest';

import { hasTraversalSegment } from './path-safety.js';

describe('hasTraversalSegment', () => {
  it('detects a POSIX ".." segment: "./a/../b"', () => {
    expect(hasTraversalSegment('./a/../b')).toBe(true);
  });

  it('detects a leading ".." segment: "../x"', () => {
    expect(hasTraversalSegment('../x')).toBe(true);
  });

  it('detects a bare ".."', () => {
    expect(hasTraversalSegment('..')).toBe(true);
  });

  it('detects a backslash-separated ".." segment: "./a\\..\\b"', () => {
    expect(hasTraversalSegment('./a\\..\\b')).toBe(true);
  });

  it('detects a mixed-separator ".." segment: "./a/..\\b"', () => {
    expect(hasTraversalSegment('./a/..\\b')).toBe(true);
  });

  it('does NOT flag a filename containing consecutive dots: "./my..config.json"', () => {
    expect(hasTraversalSegment('./my..config.json')).toBe(false);
  });

  it('does NOT flag a directory name containing consecutive dots: "./a..b/c.json"', () => {
    expect(hasTraversalSegment('./a..b/c.json')).toBe(false);
  });

  it('does NOT flag a traversal-free path: "./a/b.json"', () => {
    expect(hasTraversalSegment('./a/b.json')).toBe(false);
  });

  it('does NOT flag a single-dot segment: "./a/./b"', () => {
    expect(hasTraversalSegment('./a/./b')).toBe(false);
  });
});
