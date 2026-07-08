/**
 * Tests for the shared Open Plugins conformance helpers.
 *
 * The name grammar under test is the Open Plugins v1.0.0 spec §2.1 grammar; the advisories are the
 * SOFT, portability-only nudges of spec §7 / OP-D10 (they must never be hard).
 *
 * @see docs/specs/open-plugins-target.md §7
 * @see https://open-plugins.com/plugin-builders/specification.md
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isValidOpenPluginsName,
  metadataDirConformanceFindings,
  nameGrammarConformanceFindings,
  openPluginsNameSchema,
} from './open-plugins-conformance.js';

// ---------------------------------------------------------------------------
// isValidOpenPluginsName + openPluginsNameSchema (spec §2.1)
// ---------------------------------------------------------------------------

describe('isValidOpenPluginsName', () => {
  it.each(['a', 'skill-evaluator', '0abc', 'a.b', 'a1.b2-c3'])('accepts %s', (name) => {
    expect(isValidOpenPluginsName(name)).toBe(true);
  });

  it.each(['', 'a--b', 'abc-', 'abc.', '-abc', 'a..b', 'MyPlugin', 'a'.repeat(65)])(
    'rejects %s',
    (name) => {
      expect(isValidOpenPluginsName(name)).toBe(false);
    },
  );

  it('the Zod schema agrees with the predicate', () => {
    expect(openPluginsNameSchema.safeParse('a.b').success).toBe(true);
    expect(openPluginsNameSchema.safeParse('a--b').success).toBe(false);
    expect(openPluginsNameSchema.safeParse('abc-').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nameGrammarConformanceFindings (spec §7)
// ---------------------------------------------------------------------------

describe('nameGrammarConformanceFindings', () => {
  it('emits one SOFT open-plugins-conformance finding for an Open-Plugins-illegal name', () => {
    const findings = nameGrammarConformanceFindings(
      'my-plugin',
      '.claude-plugin/plugin.json',
      'a--b',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'soft',
      code: 'open-plugins-conformance',
      plugin: 'my-plugin',
    });
    expect(findings[0]?.message).toContain('a--b');
    expect(findings[0]?.hint).toBeDefined();
  });

  it('also flags a trailing hyphen (native-legal scaffold slug, Open-Plugins-illegal)', () => {
    expect(nameGrammarConformanceFindings('p', '.cursor-plugin/plugin.json', 'abc-')).toHaveLength(
      1,
    );
  });

  it('emits nothing for an Open-Plugins-valid name', () => {
    expect(
      nameGrammarConformanceFindings('p', '.claude-plugin/plugin.json', 'skill-evaluator'),
    ).toEqual([]);
  });

  it('emits nothing for a non-string name (nothing to advise on)', () => {
    expect(nameGrammarConformanceFindings('p', '.claude-plugin/plugin.json', undefined)).toEqual(
      [],
    );
    expect(nameGrammarConformanceFindings('p', '.claude-plugin/plugin.json', 42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// metadataDirConformanceFindings (spec §7)
// ---------------------------------------------------------------------------

describe('metadataDirConformanceFindings', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-conformance-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVendor(rel: string, content = '{}'): void {
    const full = path.join(tmpDir, '.claude-plugin', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('emits one SOFT finding listing the stray entry when the vendor dir holds more than plugin.json', () => {
    writeVendor('plugin.json');
    writeVendor('extra.txt', 'stray');
    const findings = metadataDirConformanceFindings(tmpDir, '.claude-plugin', 'my-plugin');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'soft', code: 'open-plugins-conformance' });
    expect(findings[0]?.message).toContain('extra.txt');
  });

  it('flags a stray subdirectory too', () => {
    writeVendor('plugin.json');
    fs.mkdirSync(path.join(tmpDir, '.claude-plugin', 'nested'));
    expect(metadataDirConformanceFindings(tmpDir, '.claude-plugin', 'my-plugin')).toHaveLength(1);
  });

  it('emits nothing when the vendor dir holds only plugin.json', () => {
    writeVendor('plugin.json');
    expect(metadataDirConformanceFindings(tmpDir, '.claude-plugin', 'my-plugin')).toEqual([]);
  });

  it('emits nothing when the vendor dir is absent', () => {
    expect(metadataDirConformanceFindings(tmpDir, '.claude-plugin', 'my-plugin')).toEqual([]);
  });

  it('emits a SOFT advisory when the vendor dir exists as a FILE (ENOTDIR), mirroring the hard check', () => {
    // `.claude-plugin` as a plain file makes readdir throw ENOTDIR — report it rather than pass.
    fs.writeFileSync(path.join(tmpDir, '.claude-plugin'), 'not a dir', 'utf-8');
    const findings = metadataDirConformanceFindings(tmpDir, '.claude-plugin', 'my-plugin');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'soft', code: 'open-plugins-conformance' });
    expect(findings[0]?.message).toMatch(/not a directory/i);
  });
});
