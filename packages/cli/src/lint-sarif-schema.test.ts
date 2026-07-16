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
// `@cfworker/json-schema`, not `ajv`: ajv compiles schemas by generating and evaluating code
// strings (`new Function`), which gets flagged/blocked in locked-down environments. `Validator`
// is pure-evaluation — no codegen, no `eval`/`new Function` — so it stays usable there.
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@ai-plugin-marketplace/core';
import { buildLintSarif } from './lint-format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(HERE, 'lint', 'sarif-2.1.0.schema.json'), 'utf-8'),
) as object;

// Draft '7': the vendored schema's own `$schema` is `http://json-schema.org/draft-07/schema#`.
const validator = new Validator(schema, '7');

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
    const result = validator.validate(sarif);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates an empty-results log (a clean lint run)', () => {
    const sarif = buildLintSarif([], '1.2.3');
    const result = validator.validate(sarif);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
