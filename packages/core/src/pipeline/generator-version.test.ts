/**
 * Tests for the generator-version stamp reader + downgrade guard (§4.3.1).
 *
 * The guard is the protection against a stale installed toolkit silently reverting generated
 * artifacts to an older generator's output. Version ordering uses semver precedence, never string
 * comparison — `0.10.0` is newer than `0.9.0` even though it sorts earlier lexically.
 *
 * @see docs/specs/architecture.md §4.3.1 (generator-version stamp + downgrade guard)
 * @see https://semver.org/
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GeneratorDowngradeError,
  assertGeneratorNotDowngraded,
  findNewestDowngrade,
  formatGeneratorId,
  getGeneratorVersion,
  type StampedArtifact,
} from './generator-version.js';

describe('getGeneratorVersion', () => {
  it('returns the version declared in this package.json (never a hardcoded literal)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(getGeneratorVersion()).toBe(pkg.version);
  });
});

describe('formatGeneratorId', () => {
  it('renders the canonical package@version identity', () => {
    expect(formatGeneratorId('0.8.0')).toBe('@ai-plugin-marketplace/core@0.8.0');
  });
});

describe('findNewestDowngrade', () => {
  const stamp = (path: string, version: string): StampedArtifact => ({ path, version });

  it('returns undefined when the installed version equals the only stamp (same-version rebuild)', () => {
    expect(findNewestDowngrade('0.8.0', [stamp('a/cursor.json', '0.8.0')])).toBeUndefined();
  });

  it('returns undefined when the installed version is newer than every stamp', () => {
    expect(
      findNewestDowngrade('0.9.0', [
        stamp('a/cursor.json', '0.8.0'),
        stamp('b/claude.json', '0.7.0'),
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for an empty artifact set (fresh generation)', () => {
    expect(findNewestDowngrade('0.8.0', [])).toBeUndefined();
  });

  it('flags the newest stamp when the installed version is older (§4.3.1)', () => {
    const worst = findNewestDowngrade('0.7.0', [
      stamp('a/cursor.json', '0.8.0'),
      stamp('b/claude.json', '0.8.1'),
    ]);
    expect(worst).toEqual({ path: 'b/claude.json', version: '0.8.1' });
  });

  it('uses semver precedence, not string comparison (0.10.0 > 0.9.0)', () => {
    // Lexically '0.10.0' < '0.9.0'; semver-correctly it is newer, so an installed 0.9.0 is a
    // downgrade against a 0.10.0 stamp.
    const worst = findNewestDowngrade('0.9.0', [stamp('a/cursor.json', '0.10.0')]);
    expect(worst).toEqual({ path: 'a/cursor.json', version: '0.10.0' });
  });

  it('ignores unparseable stamps (they impose no constraint)', () => {
    expect(findNewestDowngrade('0.7.0', [stamp('a/cursor.json', 'not-a-version')])).toBeUndefined();
  });

  it('fails open on an unparseable installed version (never blocks a build on that)', () => {
    expect(findNewestDowngrade('garbage', [stamp('a/cursor.json', '0.8.0')])).toBeUndefined();
  });
});

describe('assertGeneratorNotDowngraded', () => {
  const stamp = (path: string, version: string): StampedArtifact => ({ path, version });

  it('throws GeneratorDowngradeError naming BOTH versions when installed is older (criterion 1/5)', () => {
    // Real occurrence: core 0.7.0 installed, an artifact stamped by 0.8.0.
    let thrown: unknown;
    try {
      assertGeneratorNotDowngraded('0.7.0', [
        stamp('plugins/toolsmith/hooks/cursor.json', '0.8.0'),
      ]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GeneratorDowngradeError);
    const err = thrown as GeneratorDowngradeError;
    expect(err.installedVersion).toBe('0.7.0');
    expect(err.stampedVersion).toBe('0.8.0');
    expect(err.artifactPath).toBe('plugins/toolsmith/hooks/cursor.json');
    // The message must name both versions and the remediation.
    expect(err.message).toContain('@ai-plugin-marketplace/core@0.7.0');
    expect(err.message).toContain('@ai-plugin-marketplace/core@0.8.0');
    expect(err.message).toContain('pnpm install');
    expect(err.message).toContain('plugins/toolsmith/hooks/cursor.json');
  });

  it('does NOT throw for a same-version rebuild (criterion 3)', () => {
    expect(() => {
      assertGeneratorNotDowngraded('0.8.0', [stamp('a/cursor.json', '0.8.0')]);
    }).not.toThrow();
  });

  it('does NOT throw when the installed version is newer (criterion 4)', () => {
    expect(() => {
      assertGeneratorNotDowngraded('0.9.0', [stamp('a/cursor.json', '0.8.0')]);
    }).not.toThrow();
  });

  it('does NOT throw for a fresh/unstamped tree (criterion 2)', () => {
    expect(() => {
      assertGeneratorNotDowngraded('0.8.0', []);
    }).not.toThrow();
  });

  it('proceeds when forceDowngrade is set, even on an older installed version', () => {
    expect(() => {
      assertGeneratorNotDowngraded('0.7.0', [stamp('a/cursor.json', '0.8.0')], true);
    }).not.toThrow();
  });
});
