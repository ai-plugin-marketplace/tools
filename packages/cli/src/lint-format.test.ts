/**
 * Unit tests for the `aipm lint` output renderers (text/json/sarif) — spec-derived assertions
 * per docs/specs/lint-engine.md §4.1: exit codes, the text line format (with and without a
 * `range`), and the json `Diagnostic[]` + summary envelope shape.
 *
 * @see docs/specs/lint-engine.md §4.1
 */

import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@ai-plugin-marketplace/core';
import { buildLintJson, buildLintSarif, formatLintText, lintExitCode } from './lint-format.js';

const RANGED: Diagnostic = {
  ruleId: 'correctness/broken-file-ref',
  category: 'correctness',
  severity: 'error',
  message: "reference to './agents/missing.md' does not exist",
  file: 'plugins/my-plugin/.claude-plugin/plugin.json',
  range: { start: { line: 3, col: 12 }, end: { line: 3, col: 30 } },
  docsUrl: 'https://docs.example.com/rules/correctness/broken-file-ref',
};

// File-scoped diagnostic with no `range` — mirrors a legacy-migrated rule's Diagnostic
// (`diagnostic.ts`'s `findingToDiagnostic` never sets `range`).
const FILE_SCOPED: Diagnostic = {
  ruleId: 'correctness/envelope-adherence',
  category: 'correctness',
  severity: 'warn',
  message: 'plugin envelope could not be resolved',
  file: 'plugins/my-plugin',
  docsUrl: 'https://docs.example.com/rules/correctness/envelope-adherence',
  legacyCode: 'schema-invalid',
};

describe('lintExitCode()', () => {
  it('is 0 when no diagnostic has error severity', () => {
    expect(lintExitCode([FILE_SCOPED])).toBe(0);
    expect(lintExitCode([])).toBe(0);
  });

  it('is 1 when at least one diagnostic has error severity', () => {
    expect(lintExitCode([FILE_SCOPED, RANGED])).toBe(1);
  });
});

describe('formatLintText()', () => {
  it('renders a ranged diagnostic as file:line:col ruleId severity message (spec §4.1)', () => {
    const text = formatLintText([RANGED]);
    expect(text).toContain(
      "plugins/my-plugin/.claude-plugin/plugin.json:3:12 correctness/broken-file-ref error reference to './agents/missing.md' does not exist",
    );
  });

  it('renders a range-less diagnostic as file ruleId severity message, position omitted not zero-filled (L-D1)', () => {
    const text = formatLintText([FILE_SCOPED]);
    expect(text).toContain(
      'plugins/my-plugin correctness/envelope-adherence warn plugin envelope could not be resolved',
    );
    // The omitted-position rendering must not contain a zero-filled position segment.
    expect(text).not.toContain('plugins/my-plugin:0:0');
  });

  it('appends the docs URL only when verbose is set', () => {
    const plain = formatLintText([RANGED], { verbose: false });
    const verbose = formatLintText([RANGED], { verbose: true });
    expect(plain).not.toContain(RANGED.docsUrl);
    expect(verbose).toContain(`(${RANGED.docsUrl})`);
  });

  it('reports "OK — no findings." when there are no diagnostics', () => {
    expect(formatLintText([])).toBe('OK — no findings.');
  });

  it('groups output by file (all lines for a file are contiguous)', () => {
    const other: Diagnostic = { ...RANGED, file: 'plugins/a/plugin.json' };
    const text = formatLintText([RANGED, other]);
    const lines = text.split('\n').filter((l) => l.startsWith('plugins/'));
    expect(lines[0]).toContain('plugins/a/plugin.json');
    expect(lines[1]).toContain('plugins/my-plugin/.claude-plugin/plugin.json');
  });
});

describe('buildLintJson()', () => {
  it('returns the raw Diagnostic[] plus a summary envelope (spec §4.1)', () => {
    const output = buildLintJson([RANGED, FILE_SCOPED]);
    expect(output.diagnostics).toEqual([RANGED, FILE_SCOPED]);
    expect(output.summary).toEqual({
      errorCount: 1,
      warnCount: 1,
      infoCount: 0,
      fileCount: 2,
    });
  });

  it('reports a zeroed summary for an empty diagnostic list', () => {
    expect(buildLintJson([]).summary).toEqual({
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      fileCount: 0,
    });
  });
});

describe('buildLintSarif()', () => {
  it('emits SARIF 2.1.0 with one rules[] entry per distinct ruleId', () => {
    const duplicate: Diagnostic = { ...RANGED, message: 'a second broken-file-ref finding' };
    const sarif = buildLintSarif([RANGED, duplicate, FILE_SCOPED], '1.2.3');
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('aipm');
    expect(sarif.runs[0].tool.driver.version).toBe('1.2.3');
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r) => r.id);
    expect(ruleIds).toEqual(['correctness/broken-file-ref', 'correctness/envelope-adherence']);
    expect(sarif.runs[0].results).toHaveLength(3);
  });

  it('maps error/warn/info severities to SARIF error/warning/note levels', () => {
    const info: Diagnostic = { ...FILE_SCOPED, ruleId: 'agent-ux/x', severity: 'info' };
    const sarif = buildLintSarif([RANGED, FILE_SCOPED, info], '1.0.0');
    expect(sarif.runs[0].results.map((r) => r.level)).toEqual(['error', 'warning', 'note']);
  });

  it('includes a region only for diagnostics that carry a range', () => {
    const sarif = buildLintSarif([RANGED, FILE_SCOPED], '1.0.0');
    const [rangedResult, fileScopedResult] = sarif.runs[0].results;
    expect(rangedResult?.locations[0]?.physicalLocation.region).toEqual({
      startLine: 3,
      startColumn: 12,
      endLine: 3,
      endColumn: 30,
    });
    expect(fileScopedResult?.locations[0]?.physicalLocation.region).toBeUndefined();
  });
});
