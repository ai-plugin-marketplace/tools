/**
 * `schema/envelope-shape` — `aipm.config.ts` parses strictly against the envelope schema
 * (§10.1 step 1). Wraps the existing `validateEnvelopeShape()` check.
 *
 * Unlike the other migrated rules, this one runs *before* a plugin's envelope (`ctx.envelope`)
 * is known — it is what determines whether the envelope can be trusted at all. It therefore
 * loads the raw `aipm.config.ts` default export itself rather than reading anything off
 * `RuleContext.envelope`. A missing `aipm.config.ts` (including a plugin-shaped directory
 * discovered without one, per #91) is reported here too, as an `envelope-invalid` diagnostic
 * equivalent to `validate()`'s — `lint` and `validate` must agree on this case rather than one
 * staying silent while the other flags it (#101).
 *
 * Reuses `ctx.configCache` (via {@link loadPluginConfig}) rather than importing the raw config a
 * second time: `loadPluginConfig` transpiles-and-validates once and caches the result, so when
 * the engine's subsequent envelope resolution calls `loadPluginConfig` for the same plugin, it is
 * a cache hit rather than a second jiti transpile. On a `ConfigLoadError` whose `cause` is the
 * `ZodError` `defineConfig` throws for a schema violation, this rule reformats those issues into
 * the same per-issue diagnostics `validateEnvelopeShape` would have produced from the raw value;
 * any other failure (import/syntax error) is left to load-config's own `ConfigLoadError` path in
 * `validate()`'s orchestration.
 *
 * @see docs/specs/lint-engine.md L-D2
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  AIPM_CONFIG_FILENAME,
  ConfigLoadError,
  loadPluginConfig,
} from '../../pipeline/load-config.js';
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
    const configPath = path.join(ctx.pluginDir, AIPM_CONFIG_FILENAME);
    const pluginName = path.basename(ctx.pluginDir);
    if (!fs.existsSync(configPath)) {
      // Mirrors validate()'s `envelope-invalid` finding for the identical failure (#91's
      // discovery path surfaces a plugin-shaped, config-less directory; without this, lint stayed
      // silent while validate/build both flagged it — #101). loadPluginConfig throws the same
      // ConfigLoadError message for this case; reproduce it directly here rather than calling
      // loadPluginConfig only to immediately catch it, since this path never reaches the cache.
      const message = `No ${AIPM_CONFIG_FILENAME} found in ${ctx.pluginDir}. Every plugin must declare a support envelope (spec §6.1).`;
      return [
        findingToDiagnostic(
          { severity: 'hard', code: 'envelope-invalid', plugin: pluginName, message },
          RULE_ID,
          'schema',
          docsUrlFor(RULE_ID),
        ),
      ];
    }
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
      // Import failure (syntax error, etc.) is reported by load-config's own ConfigLoadError
      // path in validate()'s orchestration; nothing further to add here.
      return [];
    }
  },
};
