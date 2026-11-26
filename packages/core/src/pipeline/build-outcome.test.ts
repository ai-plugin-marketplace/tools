import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { build, buildWithOutcome, validate } from '../index.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import * as validator from './validate.js';

let repo: SynthRegistryRepo | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  repo?.cleanup();
});

it.each(['', 'true'])(
  'keeps freshness I/O findings in the opt-in outcome with CI=%j',
  async (ci) => {
    vi.stubEnv('CI', ci);
    repo = synthRegistryRepo([
      {
        name: 'gem',
        targets: ['gemini'],
        files: {
          'gemini-extension.json': '{"name":"gem","version":"0.0.1"}',
          'GEMINI.md': '# Gemini\n',
        },
      },
    ]);
    const failure = Object.assign(new Error('Cannot create a freshness directory'), {
      code: 'EACCES',
      errno: -13,
      syscall: 'mkdtemp',
    });
    const mkdtempSync = fs.mkdtempSync;
    const makeTempDir = vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
      if (prefix.endsWith('aipm-freshness-')) throw failure;
      return mkdtempSync(prefix, options);
    });
    syncBuiltinESMExports();

    const legacyResults = await build(repo.repoRoot, { failFast: true });
    expect(makeTempDir.mock.calls.some(([prefix]) => prefix.endsWith('aipm-freshness-'))).toBe(
      false,
    );
    const { results, validation } = await buildWithOutcome(repo.repoRoot, { failFast: true });

    expect(legacyResults[0]?.artifacts).toStrictEqual(results[0]?.artifacts);
    const manifestPath = path.join(repo.repoRoot, 'dist', 'gemini', 'gem', 'gemini-extension.json');
    expect(results[0]?.artifacts.map((artifact) => artifact.path)).toContain(manifestPath);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(validation.passed).toBe(false);
    expect(validation.findings).toContainEqual({
      code: 'freshness-io',
      severity: 'hard',
      plugin: 'gem',
      message: failure.message,
    });
    await expect(validate(repo.repoRoot)).rejects.toBe(failure);
  },
);

it('retains hard structural findings when a repo-root artifact cannot be read', async () => {
  repo = synthRegistryRepo(
    [
      {
        name: 'gem',
        targets: ['gemini'],
        files: {
          'gemini-extension.json': '{"name":"gem","version":"0.0.1"}',
          'GEMINI.md': '# Gemini\n',
        },
      },
      ...['kiro-one', 'kiro-two'].map((name) => ({
        name,
        targets: ['kiro'] as const,
        files: {
          'POWER.md': `---\nname: ${name}\ndescription: ${name} power\nversion: 0.0.1\n---\n# ${name}\n`,
        },
      })),
    ],
    { name: 'workspace' },
  );
  const rootContext = path.join(repo.repoRoot, 'GEMINI.md');
  const failure = Object.assign(new Error('Cannot read the repo-root GEMINI.md'), {
    code: 'EACCES',
    errno: -13,
    syscall: 'open',
  });
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === rootContext) throw failure;
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();

  const { results, validation } = await buildWithOutcome(repo.repoRoot);

  expect(results).toHaveLength(3);
  expect(validation.passed).toBe(false);
  expect(validation.findings).toContainEqual(
    expect.objectContaining({ code: 'single-artifact-host', severity: 'hard' }),
  );
  expect(validation.findings).toContainEqual({
    code: 'freshness-io',
    severity: 'hard',
    message: failure.message,
  });
  const failureSummary =
    'Build produced 1 hard validation finding(s):\n  [?] single-artifact-host:';
  await expect(build(repo.repoRoot, { failFast: true })).rejects.toThrow(failureSummary);
  await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(failureSummary);
});

it.each([
  ['build', build],
  ['buildWithOutcome', buildWithOutcome],
])('runs the internal validator exactly once from %s', async (_name, buildPlugin) => {
  repo = synthRegistryRepo([
    {
      name: 'skills',
      targets: ['vercel'],
      files: {
        'skills/example/SKILL.md':
          '---\nname: example\ndescription: Example skill\n---\n# Example\n',
      },
    },
  ]);
  const runValidate = vi.spyOn(validator, 'runValidate');

  await buildPlugin(repo.repoRoot);

  expect(runValidate).toHaveBeenCalledTimes(1);
});
