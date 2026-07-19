/**
 * Tests for the validate orchestrator (`runValidate`) — §5.3, §10.1, §10.3, §10.5.
 *
 * These focus on the ORCHESTRATION the unit tests in `validate.test.ts` do not cover: envelope
 * loading, the §10.1/§10.3 ordering and blocking rules, the freshness check, and the `passed`
 * flag semantics (§10.2). They deliberately do not re-test the individual cross-target validators.
 *
 * Developer-machine-only: depend on a local template checkout. Self-skip when absent.
 *
 * @see docs/specs/architecture.md §10.1 (validator order), §10.2 (hard/soft), §10.3 (blocking)
 * @see docs/specs/architecture.md §10.5 (freshness), §5.3 (validate phase)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBuild } from './build.js';
import { runValidate } from './validate.js';
import {
  ALL_SYNTH_TARGETS,
  SYNTH_PLUGIN_NAME,
  synthPluginRepo,
} from '../test-support/synth-plugin.js';
import type { SynthRepo } from '../test-support/synth-plugin.js';
import type { Finding, FindingCode } from './types.js';
import { TEMPLATE_REPO_AVAILABLE } from '../test-support/template-repo.js';

const describeMaybe = TEMPLATE_REPO_AVAILABLE ? describe : describe.skip;

/** Codes present in a finding list. */
function codes(findings: Finding[]): FindingCode[] {
  return findings.map((f) => f.code);
}

/** Findings of a given code. */
function ofCode(findings: Finding[], code: FindingCode): Finding[] {
  return findings.filter((f) => f.code === code);
}

// ---------------------------------------------------------------------------

describeMaybe('runValidate — clean plugin (§10.2 passed flag)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('a built, all-targets plugin passes with zero hard findings', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);
    const result = await runValidate(repo.repoRoot, { ci: true });
    const hard = result.findings.filter((f) => f.severity === 'hard');
    expect(hard).toStrictEqual([]);
    expect(result.passed).toBe(true);
  });
});

describeMaybe('runValidate — envelope load (§10.1 step 1)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('a single-plugin path missing aipm.config.ts yields envelope-invalid and skips other checks', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    fs.rmSync(path.join(repo.pluginDir, 'aipm.config.ts'));

    const result = await runValidate(repo.pluginDir, { ci: true });
    expect(ofCode(result.findings, 'envelope-invalid')).toHaveLength(1);
    // Step-1 failure short-circuits: no schema/adherence/cross-target/freshness findings follow.
    expect(codes(result.findings)).toStrictEqual(['envelope-invalid']);
    expect(result.passed).toBe(false);
  });

  it('an invalid envelope (bad semver) yields envelope-invalid', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    // Overwrite the config with a semantically invalid version.
    fs.writeFileSync(
      path.join(repo.pluginDir, 'aipm.config.ts'),
      `import { defineConfig } from '@ai-plugin-marketplace/core';\nexport default defineConfig({ version: 'not-semver', targets: ['claude'] });\n`,
      'utf-8',
    );
    const result = await runValidate(repo.pluginDir, { ci: true });
    expect(ofCode(result.findings, 'envelope-invalid').length).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(false);
  });
});

describeMaybe('runValidate — cross-target consistency (§10.1 step 4)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('a name mismatch in a manifest yields name-consistency (multi-target envelope)', async () => {
    // Mutate gemini-extension.json name BEFORE build so the dist bundle stays consistent and only
    // the cross-target name check fires (the gemini schema validator only requires a string name).
    repo = synthPluginRepo(ALL_SYNTH_TARGETS, (pluginDir) => {
      const extPath = path.join(pluginDir, 'gemini-extension.json');
      const ext = JSON.parse(fs.readFileSync(extPath, 'utf-8')) as Record<string, unknown>;
      ext.name = 'totally-different-name';
      fs.writeFileSync(extPath, JSON.stringify(ext, null, 2) + '\n', 'utf-8');
    });
    await runBuild(repo.repoRoot);

    const result = await runValidate(repo.repoRoot, { ci: true });
    const nameFindings = ofCode(result.findings, 'name-consistency');
    expect(nameFindings.length).toBeGreaterThanOrEqual(1);
    expect(nameFindings.some((f) => f.message.includes('totally-different-name'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('does not run cross-target checks for a single-target envelope', async () => {
    // Single-target claude plugin: even though .cursor-plugin etc. exist (adherence fires), the
    // name-consistency / mcp-key-sync / marketplace-registration cross-target checks are skipped
    // (§10.1 step 4 requires >1 target). Inject a cursor name mismatch that WOULD fire if checked.
    repo = synthPluginRepo(['claude'], (pluginDir) => {
      const cur = path.join(pluginDir, '.cursor-plugin', 'plugin.json');
      const obj = JSON.parse(fs.readFileSync(cur, 'utf-8')) as Record<string, unknown>;
      obj.name = 'mismatch';
      fs.writeFileSync(cur, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    });
    await runBuild(repo.pluginDir);
    const result = await runValidate(repo.pluginDir, { ci: true });
    // The cursor name mismatch must NOT surface as name-consistency (cross-target skipped).
    expect(ofCode(result.findings, 'name-consistency')).toHaveLength(0);
  });

  it('a version mismatch in a manifest yields version-consistency (multi-target envelope, issue #75)', async () => {
    // Mutate gemini-extension.json's version BEFORE build so the dist bundle stays consistent and
    // only the cross-target version check fires (mirrors the name-consistency test above).
    repo = synthPluginRepo(ALL_SYNTH_TARGETS, (pluginDir) => {
      const extPath = path.join(pluginDir, 'gemini-extension.json');
      const ext = JSON.parse(fs.readFileSync(extPath, 'utf-8')) as Record<string, unknown>;
      ext.version = '9.9.9';
      fs.writeFileSync(extPath, JSON.stringify(ext, null, 2) + '\n', 'utf-8');
    });
    await runBuild(repo.repoRoot);

    const result = await runValidate(repo.repoRoot, { ci: true });
    const versionFindings = ofCode(result.findings, 'version-consistency');
    expect(versionFindings.length).toBeGreaterThanOrEqual(1);
    expect(versionFindings.some((f) => f.message.includes('9.9.9'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('does not run version-consistency for a single-target envelope', async () => {
    // Single-target claude plugin: a cursor version mismatch must NOT surface as
    // version-consistency (cross-target checks are skipped, §10.1 step 4).
    repo = synthPluginRepo(['claude'], (pluginDir) => {
      const cur = path.join(pluginDir, '.cursor-plugin', 'plugin.json');
      const obj = JSON.parse(fs.readFileSync(cur, 'utf-8')) as Record<string, unknown>;
      obj.version = '9.9.9';
      fs.writeFileSync(cur, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    });
    await runBuild(repo.pluginDir);
    const result = await runValidate(repo.pluginDir, { ci: true });
    expect(ofCode(result.findings, 'version-consistency')).toHaveLength(0);
  });
});

describeMaybe('runValidate — freshness (§10.5, §10.2)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('a hand-edited hooks/claude.json is a HARD freshness finding under ci:true', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    // Schema-valid hand-edit: change a command string so ONLY freshness (not schema) fires.
    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    const obj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const firstEvent = Object.keys(obj.hooks)[0];
    if (firstEvent === undefined) throw new Error('fixture has no hooks to edit');
    const target = obj.hooks[firstEvent]?.[0]?.hooks[0];
    if (target === undefined) throw new Error('fixture hook entry missing');
    target.command = `${target.command} # hand edit`;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.every((f) => f.severity === 'hard')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('the same hand-edit is a SOFT freshness finding under ci:false and does not flip passed', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    const obj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const firstEvent = Object.keys(obj.hooks)[0];
    if (firstEvent === undefined) throw new Error('fixture has no hooks to edit');
    const target = obj.hooks[firstEvent]?.[0]?.hooks[0];
    if (target === undefined) throw new Error('fixture hook entry missing');
    target.command = `${target.command} # hand edit`;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: false });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.every((f) => f.severity === 'soft')).toBe(true);
    // Soft findings do not flip passed (no other hard findings in a clean all-targets fixture).
    expect(result.passed).toBe(true);
  });

  it('a stale dist bundle file is a freshness finding naming the path', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    // Tamper with a committed dist file: regeneration will diverge.
    const distGeminiMd = path.join(repo.repoRoot, 'dist', 'gemini', SYNTH_PLUGIN_NAME, 'GEMINI.md');
    fs.appendFileSync(distGeminiMd, '\n<!-- tampered -->\n');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('GEMINI.md'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('a formatting-only (reindented) hooks/claude.json is still a HARD freshness finding (§4.3.1)', async () => {
    // The generator-version normalization strips ONLY the version stamp, not formatting — so a
    // whitespace-only hand-edit of a generated JSON artifact (same data, same version, reindented)
    // must still be flagged as stale, not masked (Copilot #81).
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    const obj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as unknown;
    // Re-serialize with 4-space indent: identical data and version, different bytes only.
    fs.writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 4) + '\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('claude.json'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('a pure generator-version bump in hooks/claude.json is NOT flagged (§4.3.1)', async () => {
    // Conversely, an artifact that differs from a fresh build ONLY in its stamped version is fresh:
    // a version bump alone must not mark every committed artifact stale.
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    const obj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
      _generated: Record<string, unknown>;
    };
    // Bump only the stamp to a newer version, preserving canonical formatting.
    obj._generated['version'] = '999.0.0';
    fs.writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    const result = await runValidate(repo.repoRoot, { ci: true });
    const fresh = ofCode(result.findings, 'freshness');
    expect(fresh.some((f) => f.message.includes('claude.json'))).toBe(false);
  });

  it('skipFreshness suppresses the freshness check entirely', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);

    const claudeJsonPath = path.join(repo.pluginDir, 'hooks', 'claude.json');
    fs.appendFileSync(claudeJsonPath, ' ');

    const result = await runValidate(repo.repoRoot, { ci: true, skipFreshness: true });
    expect(ofCode(result.findings, 'freshness')).toHaveLength(0);
  });
});

describeMaybe('runValidate — repo root with multiple plugins', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('discovers and validates every plugin under plugins/ that has a config', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    await runBuild(repo.repoRoot);
    // A sibling directory without a config must be ignored by discovery.
    fs.mkdirSync(path.join(repo.repoRoot, 'plugins', 'not-a-plugin'), { recursive: true });

    const result = await runValidate(repo.repoRoot, { ci: true });
    // Only the configured plugin is validated; no findings reference 'not-a-plugin'.
    expect(result.findings.every((f) => f.plugin !== 'not-a-plugin')).toBe(true);
    expect(result.passed).toBe(true);
  });
});

describeMaybe('runValidate — repo config (aipm.repo.ts)', () => {
  let repo: SynthRepo;
  afterEach(() => {
    repo.cleanup();
  });

  it('surfaces an invalid aipm.repo.ts as a single repo-config-invalid finding', async () => {
    repo = synthPluginRepo(ALL_SYNTH_TARGETS);
    // An absolute pluginsRoot is rejected by defineRepoConfig.
    fs.writeFileSync(
      path.join(repo.repoRoot, 'aipm.repo.ts'),
      `export default { pluginsRoot: '/absolute' };\n`,
      'utf-8',
    );

    const result = await runValidate(repo.repoRoot, { ci: true });
    expect(codes(result.findings)).toStrictEqual(['repo-config-invalid']);
    expect(result.passed).toBe(false);
  });
});
