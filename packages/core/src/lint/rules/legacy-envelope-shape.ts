/**
 * `schema/envelope-shape` — `aipm.config.ts` parses strictly against the envelope schema
 * (§10.1 step 1). Wraps the existing `validateEnvelopeShape()` check.
 *
 * Unlike the other migrated rules, this one runs *before* a plugin's envelope (`ctx.envelope`)
 * is known — it is what determines whether the envelope can be trusted at all. It therefore
 * loads the raw `aipm.config.ts` default export itself (via the same jiti loader
 * `loadPluginConfig` uses) rather than reading anything off `RuleContext`, and reports nothing
 * when the config is missing entirely (a missing envelope is `load-config.ts`'s concern, not a
 * shape-validation one).
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIPM_CONFIG_FILENAME, importDefaultExport } from '../../pipeline/load-config.js';
import { validateEnvelopeShape } from '../../pipeline/validate.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'schema/envelope-shape';

export const envelopeShapeRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'schema',
    defaultSeverity: 'error',
    description: 'aipm.config.ts parses strictly; version is semver; targets is a known subset.',
  },
  async check(ctx: RuleContext): Promise<Diagnostic[]> {
    const configPath = path.join(ctx.pluginDir, AIPM_CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) return [];
    const pluginName = path.basename(ctx.pluginDir);
    let raw: unknown;
    try {
      raw = await importDefaultExport(configPath, AIPM_CONFIG_FILENAME);
    } catch {
      // Import failure (syntax error, etc.) is reported by load-config's own ConfigLoadError
      // path in validate()'s orchestration; nothing further to add here.
      return [];
    }
    const findings = validateEnvelopeShape(raw, pluginName);
    return findings.map((f) => findingToDiagnostic(f, RULE_ID, 'schema', docsUrlFor(RULE_ID)));
  },
};
