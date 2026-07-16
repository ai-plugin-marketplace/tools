/**
 * The `lint()` public entry point (spec §4.1's engine half; the CLI surface and non-`aipm-repo`
 * discovery modes are follow-on issues, §6 "Sequencing" steps 2–3). Discovers plugins exactly as
 * `validate()` does (`aipm-repo` mode only — the only mode this issue's scope covers) and runs
 * every rule in {@link ALL_RULES} against each plugin, plus the two repo-scoped freshness rules
 * once per repo.
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
import { PER_PLUGIN_RULES, REPO_SCOPED_RULES, envelopeShapeRule } from './rules/index.js';
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
    for (const rule of PER_PLUGIN_RULES) {
      diagnostics.push(...(await rule.check(ctx)));
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
