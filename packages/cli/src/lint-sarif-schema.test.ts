/**
 * Validates `aipm lint --format sarif` output against the official SARIF 2.1.0 JSON Schema
 * (vendored as a dev fixture, `lint/sarif-2.1.0.schema.json`) rather than asserting a hand-copied
 * gold master — a real schema violation fails this test even if the shape "looks right".
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Named import, not default: without `esModuleInterop` (avoided in libraries per repo convention),
// ajv's CJS default export isn't constructable through NodeNext resolution — the named `Ajv`
// class export is.
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@ai-plugin-marketplace/core';
import { buildLintSarif } from './lint-format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(HERE, 'lint', 'sarif-2.1.0.schema.json'), 'utf-8'),
) as object;

// `unicodeRegExp: false`: the schema's `language` property pattern is not valid under the `u`
// regex flag ajv otherwise compiles with — this only affects that unrelated property.
const ajv = new Ajv({ strict: false, allowUnionTypes: true, unicodeRegExp: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const RANGED: Diagnostic = {
  ruleId: 'correctness/broken-file-ref',
  category: 'correctness',
  severity: 'error',
  message: "reference to './agents/missing.md' does not exist",
  file: 'plugins/my-plugin/.claude-plugin/plugin.json',
  range: { start: { line: 3, col: 12 }, end: { line: 3, col: 30 } },
  docsUrl: 'https://docs.example.com/rules/correctness/broken-file-ref',
};

const FILE_SCOPED: Diagnostic = {
  ruleId: 'correctness/envelope-adherence',
  category: 'correctness',
  severity: 'warn',
  message: 'plugin envelope could not be resolved',
  file: 'plugins/my-plugin',
  docsUrl: 'https://docs.example.com/rules/correctness/envelope-adherence',
};

describe('buildLintSarif() output against the SARIF 2.1.0 schema', () => {
  it('validates a log containing ranged and range-less results', () => {
    const sarif = buildLintSarif([RANGED, FILE_SCOPED], '1.2.3');
    const valid = validate(sarif);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('validates an empty-results log (a clean lint run)', () => {
    const sarif = buildLintSarif([], '1.2.3');
    const valid = validate(sarif);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });
});
