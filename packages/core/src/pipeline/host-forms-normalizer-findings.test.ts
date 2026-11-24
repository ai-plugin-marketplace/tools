/**
 * Tests for how a build treats the two findings the normalizer reports from the capability grid's
 * evidence, which no plugin can provoke with the grid the normalizer ships today:
 *
 * - `projection-not-implemented` (always `hard`, on one target): the grid calls for a form the
 *   normalizer cannot build yet. Per docs/specs/architecture.md §5.2.1 a `hard` finding on one
 *   target fails that target only: it publishes nothing, and the plugin's other targets build.
 * - `native-form-refuted` (always `soft`, on one target): a host's own control was not used
 *   because a recorded evaluation of it failed. A `soft` finding fails nothing; it is reported.
 *
 * The normalizer's projection is the real one, wrapped so one of these findings is added to the
 * Codex target; everything downstream of it (layout, registries, validation) is real.
 *
 * @see https://github.com/ai-plugin-marketplace/normalizer/blob/main/docs/specs/unified-model.md
 * @see docs/specs/architecture.md §5.2.1 (per-target output)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Normalizer from '@ai-plugin-marketplace/normalizer';

import { runBuild } from './build.js';
import { runValidate } from './validate.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import type { Finding } from './types.js';

/** The finding added to the Codex target's projection; `undefined` leaves the projection as is. */
const injected = vi.hoisted((): { finding: Normalizer.Finding | undefined } => ({
  finding: undefined,
}));

vi.mock('@ai-plugin-marketplace/normalizer', async (importOriginal) => {
  const actual = await importOriginal<typeof Normalizer>();
  return {
    ...actual,
    projectPluginForHosts: (
      input: Normalizer.PluginProjectionInput,
    ): Normalizer.PluginProjection => {
      const projection = actual.projectPluginForHosts(input);
      const extra = injected.finding;
      if (extra === undefined) return projection;
      return {
        ...projection,
        hosts: projection.hosts.map((host) =>
          host.target === 'codex' ? { ...host, findings: [...host.findings, extra] } : host,
        ),
      };
    },
  };
});

const PLUGIN = 'demo';
const MANIFEST = `${JSON.stringify({ name: PLUGIN, version: '0.0.1', description: 'A demo plugin.' }, null, 2)}\n`;
const USER_ONLY_SKILL =
  '---\nname: for-user\ndescription: Use when testing the for-user skill.\naudience: user\n---\n\n# for-user\n';

function synthRepo(): SynthRegistryRepo {
  return synthRegistryRepo(
    [
      {
        name: PLUGIN,
        targets: ['claude', 'codex'],
        files: {
          '.claude-plugin/plugin.json': MANIFEST,
          '.codex-plugin/plugin.json': MANIFEST,
          'skills/for-user/SKILL.md': USER_ONLY_SKILL,
        },
      },
    ],
    { name: 'grid-findings-test-marketplace' },
  );
}

function ofCode(findings: readonly Finding[], code: Finding['code']): Finding[] {
  return findings.filter((f) => f.code === code);
}

describe('findings the normalizer reports from the capability grid', () => {
  let repo: SynthRegistryRepo | undefined;
  afterEach(() => {
    injected.finding = undefined;
    repo?.cleanup();
  });

  it('fails only the target that calls for a projection the normalizer cannot build', async () => {
    injected.finding = {
      severity: 'hard',
      code: 'projection-not-implemented',
      plugin: PLUGIN,
      message: 'skill "for-user" on Codex: the conditional-read projection is not implemented',
    };
    repo = synthRepo();
    const [result] = await runBuild(repo.repoRoot);

    // Codex publishes nothing: no tree and no registry.
    const codex = result?.targets.find((t) => t.target === 'codex');
    expect(codex?.status).toBe('failed');
    expect(codex).not.toHaveProperty('dir');
    expect(fs.existsSync(path.join(repo.repoRoot, 'dist', 'codex'))).toBe(false);
    expect(fs.existsSync(path.join(repo.repoRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(
      false,
    );

    // Claude Code is unaffected: its tree is built and its registry lists it.
    expect(result?.targets.find((t) => t.target === 'claude')?.status).toBe('projected');
    const registry = JSON.parse(
      fs.readFileSync(path.join(repo.repoRoot, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ) as { plugins: { name: string; source: string }[] };
    expect(registry.plugins).toStrictEqual([{ name: PLUGIN, source: './dist/claude/demo' }]);

    // Validation reports the finding, as a failure.
    const validation = await runValidate(repo.repoRoot, { ci: true });
    const reported = ofCode(validation.findings, 'projection-not-implemented');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ severity: 'hard', plugin: PLUGIN });
    expect(validation.passed).toBe(false);
  });

  it('reports a refuted host control as a warning and still builds the target', async () => {
    injected.finding = {
      severity: 'soft',
      code: 'native-form-refuted',
      plugin: PLUGIN,
      message: 'skill "for-user" on Codex: a recorded evaluation of its own control failed',
    };
    repo = synthRepo();
    const [result] = await runBuild(repo.repoRoot);

    const codex = result?.targets.find((t) => t.target === 'codex');
    expect(codex).toMatchObject({
      status: 'projected',
      dir: path.join(repo.repoRoot, 'dist', 'codex', PLUGIN),
    });
    expect(fs.existsSync(path.join(repo.repoRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(
      true,
    );

    const validation = await runValidate(repo.repoRoot, { ci: true });
    const reported = ofCode(validation.findings, 'native-form-refuted');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ severity: 'soft', plugin: PLUGIN });
    expect(validation.findings.filter((f) => f.severity === 'hard')).toStrictEqual([]);
    expect(validation.passed).toBe(true);
  });
});
