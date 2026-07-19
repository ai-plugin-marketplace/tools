/**
 * The `lint()` public entry point (spec §4.1's engine half; the CLI surface and non-`aipm-repo`
 * discovery modes are follow-on issues, §6 "Sequencing" steps 2–3). Discovers plugins exactly as
 * `validate()` does (`aipm-repo` mode only — the only mode this issue's scope covers) and runs
 * every rule the engine knows about against each plugin, plus the repo-scoped rules once per
 * repo — replicating `pipeline/validate.ts`'s `runValidate` gating exactly (§10.1 step 4 / §10.3)
 * so `lint()` and `validate()` agree on when cross-target consistency rules fire.
 *
 * A plugin whose envelope fails to load contributes no diagnostics beyond what
 * `envelopeShapeRule` itself finds (mirroring `validate()`'s short-circuit on an unusable
 * envelope) — there is no envelope to run the other rules' `RuleContext` against.
 */

import {
  createConfigCache,
  loadPluginConfig,
  loadWorkspaceConfig,
} from '../pipeline/load-config.js';
import { discoverPlugins } from '../pipeline/discover.js';
import { createRuleContext } from './context.js';
import {
  PER_PLUGIN_RULES,
  REPO_SCOPED_RULES,
  envelopeShapeRule,
  marketplaceRegistrationRule,
  mcpKeySyncRule,
  nameConsistencyRule,
  targetSchemaRule,
  versionConsistencyRule,
} from './rules/index.js';
import type { Diagnostic, LintOptions, LintResult } from './types.js';

/**
 * Lint a single plugin directory or a repo root (aipm-repo discovery mode). Runs every rule the
 * engine knows about and returns the combined, unfiltered diagnostics (no rule-config/severity
 * overrides or suppression — L-D6 configuration is CLI-issue scope, §6 step 2).
 *
 * @public
 */
export async function lint(targetPath: string, options?: LintOptions): Promise<LintResult> {
  const ci = options?.ci ?? false;
  const { repoRoot, distDir, pluginDirs } = await discoverPlugins(targetPath);
  const workspace = await loadWorkspaceConfig(repoRoot);
  const configCache = createConfigCache();
  // Registry generation opted in (aipm.workspace.ts present) — mirrors `runValidate`'s
  // `generatesRegistries`. When true, marketplace-registration is skipped below in favor of the
  // registry-freshness rule, which is what actually enforces registry correctness in that mode
  // (§10.1 step 4 comment in `pipeline/validate.ts`, "design spec, locked decision 2").
  const generatesRegistries = workspace !== undefined;

  const diagnostics: Diagnostic[] = [];

  for (const pluginDir of pluginDirs) {
    const shapeCtx = createRuleContext({
      pluginDir,
      repoRoot,
      distDir,
      envelope: [],
      allPluginDirs: pluginDirs,
      workspace,
      ci,
      configCache,
    });
    diagnostics.push(...(await envelopeShapeRule.check(shapeCtx)));

    let envelope;
    try {
      envelope = (await loadPluginConfig(pluginDir, configCache)).targets;
    } catch {
      // Unusable envelope: envelopeShapeRule (or the config loader itself) already explains why;
      // no other rule can run without a resolved envelope.
      continue;
    }

    const ctx = createRuleContext({
      pluginDir,
      repoRoot,
      distDir,
      envelope,
      allPluginDirs: pluginDirs,
      workspace,
      ci,
      configCache,
    });

    // Schema validation runs first and separately (not via PER_PLUGIN_RULES) so its diagnostics
    // determine `hasBlockingSchemaError`, exactly as `runValidate` computes it from
    // `targetSchemaRule`'s findings before deciding whether cross-target checks may run.
    const schemaDiagnostics = await targetSchemaRule.check(ctx);
    diagnostics.push(...schemaDiagnostics);
    const hasBlockingSchemaError = schemaDiagnostics.some((d) => d.severity === 'error');

    for (const rule of PER_PLUGIN_RULES) {
      diagnostics.push(...(await rule.check(ctx)));
    }

    // Cross-target consistency (§10.1 step 4: multi-target only; §10.3: schema errors block) —
    // matches `runValidate`'s `if (envelope.length > 1 && !hasBlockingSchemaError)` block exactly.
    if (envelope.length > 1 && !hasBlockingSchemaError) {
      diagnostics.push(...(await nameConsistencyRule.check(ctx)));
      diagnostics.push(...(await versionConsistencyRule.check(ctx)));
      diagnostics.push(...(await mcpKeySyncRule.check(ctx)));
      // When registries are generated, their correctness is enforced by registry-freshness
      // instead — skip the hand-authored-registry check to avoid double-reporting.
      if (!generatesRegistries) {
        diagnostics.push(...(await marketplaceRegistrationRule.check(ctx)));
      }
    }
  }

  // Repo-scoped rules run once, against a repo-level context (pluginDir is a placeholder — these
  // rules only read ctx.repoRoot/ctx.allPluginDirs/ctx.workspace).
  const repoCtx = createRuleContext({
    pluginDir: repoRoot,
    repoRoot,
    distDir,
    envelope: [],
    allPluginDirs: pluginDirs,
    workspace,
    ci,
    configCache,
  });
  for (const rule of REPO_SCOPED_RULES) {
    diagnostics.push(...(await rule.check(repoCtx)));
  }

  return { diagnostics };
}
