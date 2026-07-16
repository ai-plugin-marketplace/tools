/**
 * Output rendering for `aipm lint` (spec §4.1: text/json/sarif). Pure functions over an
 * already-computed `Diagnostic[]` — no discovery or rule logic lives here (that's
 * `@ai-plugin-marketplace/core`'s `lint()` and `applyRuleSeverityOverrides()`); this module only
 * turns diagnostics into the three CLI output shapes and computes the exit code.
 *
 * @see docs/specs/lint-engine.md §4.1
 */

import type { Diagnostic } from '@ai-plugin-marketplace/core';

export type LintFormat = 'text' | 'json' | 'sarif';

/** `Diagnostic[]` plus a summary envelope, per spec §4.1's `json` format. */
export interface LintJsonOutput {
  diagnostics: readonly Diagnostic[];
  summary: {
    errorCount: number;
    warnCount: number;
    infoCount: number;
    fileCount: number;
  };
}

/** A minimal SARIF 2.1.0 log — only the fields `aipm lint --format sarif` populates. */
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: [
    {
      tool: {
        driver: {
          name: 'aipm';
          version: string;
          informationUri: string;
          rules: { id: string; shortDescription: { text: string }; helpUri: string }[];
        };
      };
      results: {
        ruleId: string;
        level: 'error' | 'warning' | 'note';
        message: { text: string };
        locations: {
          physicalLocation: {
            artifactLocation: { uri: string };
            region?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
          };
        }[];
      }[];
    },
  ];
}

/** `0` exit code when no `error`-severity diagnostics are present, `1` otherwise (spec §4.1). */
export function lintExitCode(diagnostics: readonly Diagnostic[]): 0 | 1 {
  return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

/**
 * Render diagnostics grouped by file: `file:line:col ruleId severity message`, or — for
 * diagnostics with no `range` (file-scoped, L-D1) — `file ruleId severity message` with the
 * position segment omitted rather than zero-filled (spec §4.1). `verbose` appends the docs URL.
 */
export function formatLintText(
  diagnostics: readonly Diagnostic[],
  options: { verbose: boolean } = { verbose: false },
): string {
  const sorted = [...diagnostics].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const aLine = a.range?.start.line ?? 0;
    const bLine = b.range?.start.line ?? 0;
    if (aLine !== bLine) return aLine - bLine;
    const aCol = a.range?.start.col ?? 0;
    const bCol = b.range?.start.col ?? 0;
    return aCol - bCol;
  });

  const lines = sorted.map((d) => {
    const position =
      d.range !== undefined ? `:${String(d.range.start.line)}:${String(d.range.start.col)}` : '';
    const head = `${d.file}${position} ${d.ruleId} ${d.severity} ${d.message}`;
    return options.verbose ? `${head} (${d.docsUrl})` : head;
  });

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warnCount = diagnostics.filter((d) => d.severity === 'warn').length;
  const infoCount = diagnostics.filter((d) => d.severity === 'info').length;
  const summary =
    diagnostics.length === 0
      ? 'OK — no findings.'
      : `${String(errorCount)} error(s), ${String(warnCount)} warning(s), ${String(infoCount)} info(s).`;

  return [...lines, summary].join('\n');
}

/** Build the `json` format output: the raw diagnostics plus a summary envelope (spec §4.1). */
export function buildLintJson(diagnostics: readonly Diagnostic[]): LintJsonOutput {
  return {
    diagnostics,
    summary: {
      errorCount: diagnostics.filter((d) => d.severity === 'error').length,
      warnCount: diagnostics.filter((d) => d.severity === 'warn').length,
      infoCount: diagnostics.filter((d) => d.severity === 'info').length,
      fileCount: new Set(diagnostics.map((d) => d.file)).size,
    },
  };
}

function sarifLevel(severity: Diagnostic['severity']): 'error' | 'warning' | 'note' {
  if (severity === 'error') return 'error';
  if (severity === 'warn') return 'warning';
  return 'note';
}

/**
 * Build a SARIF 2.1.0 log: one `rules[]` entry per distinct `ruleId` (spec §4.1) and one
 * `results[]` entry per diagnostic. `toolVersion`/`informationUri` identify the CLI as the SARIF
 * "tool.driver".
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
 */
export function buildLintSarif(
  diagnostics: readonly Diagnostic[],
  toolVersion: string,
  informationUri = 'https://github.com/ai-plugin-marketplace/tools',
): SarifLog {
  const rulesById = new Map<
    string,
    { id: string; shortDescription: { text: string }; helpUri: string }
  >();
  for (const d of diagnostics) {
    if (!rulesById.has(d.ruleId)) {
      rulesById.set(d.ruleId, {
        id: d.ruleId,
        shortDescription: { text: d.message },
        helpUri: d.docsUrl,
      });
    }
  }

  return {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'aipm',
            version: toolVersion,
            informationUri,
            rules: [...rulesById.values()],
          },
        },
        results: diagnostics.map((d) => ({
          ruleId: d.ruleId,
          level: sarifLevel(d.severity),
          message: { text: d.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: d.file },
                ...(d.range !== undefined
                  ? {
                      region: {
                        startLine: d.range.start.line,
                        startColumn: d.range.start.col,
                        endLine: d.range.end.line,
                        endColumn: d.range.end.col,
                      },
                    }
                  : {}),
              },
            },
          ],
        })),
      },
    ],
  };
}
