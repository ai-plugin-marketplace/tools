import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { build } from '../index.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';
import * as validator from './validate.js';

let repo: SynthRegistryRepo | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  repo?.cleanup();
});

it('returns generated artifacts when freshness cannot create a temporary directory', async () => {
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
  const invalidTempDir = path.join(repo.repoRoot, 'temp-file');
  fs.writeFileSync(invalidTempDir, '');
  vi.stubEnv('TMPDIR', invalidTempDir);

  const { results, validation } = await build(repo.repoRoot);

  const manifestPath = path.join(repo.repoRoot, 'dist', 'gemini', 'gem', 'gemini-extension.json');
  expect(results[0]?.artifacts.map((artifact) => artifact.path)).toContain(manifestPath);
  expect(fs.existsSync(manifestPath)).toBe(true);
  expect(validation.passed).toBe(false);
  const failure = validation.findings.find((finding) => finding.code === 'freshness-io');
  expect(failure).toMatchObject({
    severity: 'hard',
    plugin: 'gem',
  });
  expect(failure?.message).toMatch(/ENOTDIR.*mkdtemp/);
});

it('runs the internal validator exactly once from public build', async () => {
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
  const validate = vi.spyOn(validator, 'runValidate');

  await build(repo.repoRoot);

  expect(validate).toHaveBeenCalledTimes(1);
});
