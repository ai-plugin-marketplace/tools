/**
 * `schema/envelope-shape` — `aipm.config.ts` loads and parses strictly against the envelope schema
 * (§10.1 step 1). Wraps the existing `validateEnvelopeShape()` check.
 *
 * Unlike the other migrated rules, this one runs *before* a plugin's envelope (`ctx.envelope`)
 * is known — it is what determines whether the envelope can be trusted at all. It therefore
 * loads `aipm.config.ts` itself rather than reading anything off `RuleContext.envelope`.
 *
 * Every way loading can fail is reported here, so `lint` never stays silent on a tree `validate`
 * and `build` both flag (#101): a missing `aipm.config.ts` (including a plugin-shaped directory
 * discovered without one, per #91), a file that cannot be imported (syntax error, no usable
 * default export), and a file that imports but violates the envelope schema. The first two become
 * a single `envelope-invalid` diagnostic carrying the loader's own message; the third is expanded
 * into the same per-issue diagnostics `validateEnvelopeShape` would have produced from the raw
 * value. This catch mirrors `runValidate()`'s envelope-load catch in `pipeline/validate.ts`, so
 * the two surfaces agree by construction rather than by a duplicated message string.
 *
 * Loading goes through {@link loadPluginConfig} with `ctx.configCache` rather than importing the
 * raw config a second time: `loadPluginConfig` transpiles-and-validates once and caches the
 * result, so when the engine's subsequent envelope resolution calls `loadPluginConfig` for the
 * same plugin, it is a cache hit rather than a second jiti transpile.
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import * as path from 'node:path';
import { z } from 'zod';
import { ConfigLoadError, loadPluginConfig } from '../../pipeline/load-config.js';
import { zodEnvelopeIssuesToFindings } from '../../pipeline/validate.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, InternalRuleContext, Rule } from '../types.js';
import { docsUrlFor } from './docs-url.js';

const RULE_ID = 'schema/envelope-shape';

export const envelopeShapeRule: Rule = {
  meta: {
    id: RULE_ID,
    category: 'schema',
    defaultSeverity: 'error',
    description: 'aipm.config.ts parses strictly; version is semver; targets is a known subset.',
    // aipm.config.ts is the aipm-repo envelope-declaration mechanism specifically.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: InternalRuleContext): Promise<Diagnostic[]> {
    const pluginName = path.basename(ctx.pluginDir);
    try {
      // A cache hit here (already validated by an earlier call in this invocation) means the
      // envelope is known-valid — nothing further to report.
      await loadPluginConfig(ctx.pluginDir, ctx.configCache);
      return [];
    } catch (err) {
      if (err instanceof ConfigLoadError && err.cause instanceof z.ZodError) {
        const findings = zodEnvelopeIssuesToFindings(err.cause.issues, pluginName);
        return findings.map((f) => findingToDiagnostic(f, RULE_ID, 'schema', docsUrlFor(RULE_ID)));
      }
      // Missing file, import/syntax failure, or an unexpected throw. Reported exactly as
      // runValidate()'s envelope-load catch reports it — same code, same severity, and the
      // loader's own message verbatim, so lint and validate cannot drift apart.
      const message = err instanceof Error ? err.message : String(err);
      return [
        findingToDiagnostic(
          { severity: 'hard', code: 'envelope-invalid', plugin: pluginName, message },
          RULE_ID,
          'schema',
          docsUrlFor(RULE_ID),
        ),
      ];
    }
  },
};
