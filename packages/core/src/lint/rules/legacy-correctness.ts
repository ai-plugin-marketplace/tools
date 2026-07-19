/**
 * `correctness/*` rules migrating the existing cross-target/cross-file `validate()` checks
 * (§3.2): envelope adherence, frontmatter parseability, name consistency, MCP key sync,
 * marketplace registration, and the default-marketplace-name advisory. Each wraps its existing
 * `pipeline/validate.ts` function and converts the resulting `Finding[]` to `Diagnostic[]`,
 * carrying the original `code` as `legacyCode`.
 *
 * These are cross-file / structural checks (no single parsed document to attach a range to), so
 * their diagnostics are file-scoped per L-D1 (no `range`).
 */

import * as path from 'node:path';
import {
  checkDefaultMarketplaceName,
  validateEnvelopeAdherence,
  validateFrontmatterParses,
  validateMarketplaceRegistration,
  validateMcpKeySync,
  validateNameConsistency,
  validateVersionConsistency,
} from '../../pipeline/validate.js';
import { findingToDiagnostic } from '../diagnostic.js';
import type { Diagnostic, InternalRuleContext, Rule, RuleContext } from '../types.js';
import { docsUrlFor } from './docs-url.js';

function wrap(ruleId: string) {
  return (
    ctx: RuleContext,
    findings: ReturnType<typeof validateEnvelopeAdherence>,
  ): Diagnostic[] => {
    void ctx;
    return findings.map((f) => findingToDiagnostic(f, ruleId, 'correctness', docsUrlFor(ruleId)));
  };
}

const ENVELOPE_ADHERENCE_ID = 'correctness/envelope-adherence';
export const envelopeAdherenceRule: Rule = {
  meta: {
    id: ENVELOPE_ADHERENCE_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'No files exist for a target outside the envelope; every in-envelope target has its minimum required files.',
    // Envelope adherence needs the resolved aipm.config.ts envelope — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    return wrap(ENVELOPE_ADHERENCE_ID)(ctx, validateEnvelopeAdherence(ctx.pluginDir, ctx.envelope));
  },
};

const FRONTMATTER_INVALID_ID = 'correctness/frontmatter-invalid';
export const frontmatterParsesRule: Rule = {
  meta: {
    id: FRONTMATTER_INVALID_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'Every frontmatter-bearing markdown file (POWER.md, SKILL.md, agents/*.md, commands/*.md) parses as strict YAML.',
    // Content-only (needs just the file's frontmatter) — applies wherever such files can appear.
    appliesTo: ['aipm-repo', 'claude-plugin', 'open-plugins', 'skills-dir', 'claude-user-config'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    const pluginName = path.basename(ctx.pluginDir);
    return wrap(FRONTMATTER_INVALID_ID)(ctx, validateFrontmatterParses(ctx.pluginDir, pluginName));
  },
};

const NAME_CONSISTENCY_ID = 'correctness/name-consistency';
export const nameConsistencyRule: Rule = {
  meta: {
    id: NAME_CONSISTENCY_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'The plugin directory name matches the `name` field in every declared target manifest.',
    // Cross-target consistency requires the resolved aipm.config.ts envelope — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    return wrap(NAME_CONSISTENCY_ID)(ctx, validateNameConsistency(ctx.pluginDir, ctx.envelope));
  },
};

const VERSION_CONSISTENCY_ID = 'correctness/version-consistency';
export const versionConsistencyRule: Rule = {
  meta: {
    id: VERSION_CONSISTENCY_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      "Every declared target's manifest `version` field matches `aipm.config.ts`'s `version`.",
    // Requires the resolved aipm.config.ts envelope and version — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  async check(ctx: InternalRuleContext): Promise<Diagnostic[]> {
    const findings = await validateVersionConsistency(ctx.pluginDir, ctx.envelope, ctx.configCache);
    return wrap(VERSION_CONSISTENCY_ID)(ctx, findings);
  },
};

const MCP_KEY_SYNC_ID = 'correctness/mcp-key-sync';
export const mcpKeySyncRule: Rule = {
  meta: {
    id: MCP_KEY_SYNC_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description: 'MCP server keys match between `.mcp.json` (Claude/Cursor) and `mcp.json` (Kiro).',
    // Cross-target consistency requires the resolved aipm.config.ts envelope — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    return wrap(MCP_KEY_SYNC_ID)(ctx, validateMcpKeySync(ctx.pluginDir, ctx.envelope));
  },
};

const MARKETPLACE_REGISTRATION_ID = 'correctness/marketplace-registration';
export const marketplaceRegistrationRule: Rule = {
  meta: {
    id: MARKETPLACE_REGISTRATION_ID,
    category: 'correctness',
    defaultSeverity: 'error',
    description:
      'The plugin is listed in the repo-root marketplace.json for every registry-backed target in its envelope, and only those.',
    // The repo-root marketplace.json concept is aipm-repo-specific.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    return wrap(MARKETPLACE_REGISTRATION_ID)(
      ctx,
      validateMarketplaceRegistration(ctx.pluginDir, ctx.repoRoot, ctx.envelope),
    );
  },
};

const DEFAULT_MARKETPLACE_NAME_ID = 'correctness/default-marketplace-name';
export const defaultMarketplaceNameRule: Rule = {
  meta: {
    id: DEFAULT_MARKETPLACE_NAME_ID,
    category: 'correctness',
    defaultSeverity: 'warn',
    description: "The repo's effective marketplace name/owner is not still a template placeholder.",
    // Marketplace identity is an aipm workspace/registry concept — aipm-repo only.
    appliesTo: ['aipm-repo'],
  },
  check(ctx: RuleContext): Diagnostic[] {
    return wrap(DEFAULT_MARKETPLACE_NAME_ID)(
      ctx,
      checkDefaultMarketplaceName(ctx.repoRoot, ctx.workspace),
    );
  },
};
