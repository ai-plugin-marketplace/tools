import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { build, buildWithOutcome, validate } from '../index.js';
import type { BuildOutcome } from '../index.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryPlugin, SynthRegistryRepo } from '../test-support/synth-plugin.js';

const claude: SynthRegistryPlugin = {
  name: 'claude',
  targets: ['claude'],
  files: { '.claude-plugin/plugin.json': '{"name":"claude","version":"0.0.1"}' },
};
let repo: SynthRegistryRepo | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  repo?.cleanup();
});

function readFindings(outcome: BuildOutcome) {
  return outcome.validation.findings.filter((finding) => finding.code === 'freshness-io');
}

function expectReadFailure(outcome: BuildOutcome, file: string, code: string) {
  expect(outcome.validation.passed).toBe(false);
  const failure = readFindings(outcome).find((finding) => finding.message.includes(file));
  expect(failure).toMatchObject({ severity: 'hard' });
  expect(failure?.message).toContain(`${code}: `);
}

function expectLegacyFindings(outcome: BuildOutcome, legacy: Awaited<ReturnType<typeof validate>>) {
  expect(outcome.validation.findings.filter(({ code }) => code !== 'freshness-io')).toEqual(
    legacy.findings,
  );
}

function failRead(file: string) {
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((input, options) => {
    if (input === file) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
        code: 'EACCES',
        path: file,
      });
    }
    return read(input, options);
  });
  syncBuiltinESMExports();
}

it.skipIf(process.platform === 'win32')('reports a dangling unpublished skill', async () => {
  repo = synthRegistryRepo([claude]);
  const file = path.join(repo.repoRoot, 'scratch', 'skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync('missing.md', file);

  await build(repo.repoRoot);
  const legacy = await validate(repo.repoRoot);
  expect(legacy.passed).toBe(true);
  const outcome = await buildWithOutcome(repo.repoRoot);
  expectLegacyFindings(outcome, legacy);
  expectReadFailure(outcome, file, 'ENOENT');
});

it('reports an unreadable skills lockfile', async () => {
  repo = synthRegistryRepo([claude]);
  const file = path.join(repo.repoRoot, 'skills-lock.json');
  fs.writeFileSync(file, '{"version":1,"skills":{}}');
  failRead(file);

  await build(repo.repoRoot);
  const legacy = await validate(repo.repoRoot);
  expect(legacy.passed).toBe(true);
  const outcome = await buildWithOutcome(repo.repoRoot);
  expectLegacyFindings(outcome, legacy);
  expectReadFailure(outcome, file, 'EACCES');
});

it.skipIf(process.platform === 'win32')(
  'keeps registry generation and host ambiguity with a dangling plugin alias',
  async () => {
    const gemini = ['gem-one', 'gem-two'].map(
      (name): SynthRegistryPlugin => ({
        name,
        targets: ['gemini'],
        files: { 'gemini-extension.json': JSON.stringify({ name, version: '0.0.1' }) },
      }),
    );
    repo = synthRegistryRepo([claude, ...gemini], { name: 'workspace' });
    const alias = path.join(repo.repoRoot, 'plugins', 'alias');
    const marketplace = path.join(repo.repoRoot, '.claude-plugin', 'marketplace.json');
    fs.symlinkSync('absent', alias, 'dir');

    const legacyBuild = await build(repo.repoRoot);
    const legacy = await validate(repo.repoRoot);
    const bytes = fs.readFileSync(marketplace, 'utf8');
    fs.rmSync(marketplace);

    const outcome = await buildWithOutcome(repo.repoRoot);
    expect(outcome.results.map(({ artifacts }) => artifacts)).toEqual(
      legacyBuild.map(({ artifacts }) => artifacts),
    );
    expect(fs.readFileSync(marketplace, 'utf8')).toBe(bytes);
    expect(legacy.findings).toContainEqual(
      expect.objectContaining({ code: 'single-artifact-host' }),
    );
    expectLegacyFindings(outcome, legacy);
    expectReadFailure(outcome, alias, 'ENOENT');
    expect(readFindings(outcome)).toHaveLength(1);
  },
);

it('keeps manifest and agent schema findings when the manifest is a directory', async () => {
  repo = synthRegistryRepo([
    {
      ...claude,
      files: { ...claude.files, 'agents/demo.md': '---\nname: false\ndescription: Demo\n---\n' },
    },
  ]);
  const file = path.join(repo.repoRoot, 'plugins', 'claude', '.claude-plugin', 'plugin.json');
  fs.rmSync(file);
  fs.mkdirSync(file);

  await build(repo.repoRoot);
  const legacy = await validate(repo.repoRoot);
  const schemaMessages = legacy.findings
    .filter(({ code }) => code === 'schema-invalid')
    .map(({ message }) => message);
  expect(schemaMessages.some((message) => message.includes('plugin.json'))).toBe(true);
  expect(schemaMessages.some((message) => message.includes('agents/demo.md'))).toBe(true);
  const outcome = await buildWithOutcome(repo.repoRoot);
  expectLegacyFindings(outcome, legacy);
  expectReadFailure(outcome, file, 'EISDIR');
});

it.skipIf(process.platform === 'win32')(
  'writes a first-build vendor registry through an in-repo directory link',
  async () => {
    repo = synthRegistryRepo([claude], { name: 'workspace' });
    fs.mkdirSync(path.join(repo.repoRoot, 'store'));
    fs.symlinkSync('store', path.join(repo.repoRoot, '.claude-plugin'), 'dir');
    const file = path.join(repo.repoRoot, 'store', 'marketplace.json');
    expect(fs.existsSync(file)).toBe(false);

    const outcome = await buildWithOutcome(repo.repoRoot);
    const bytes = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    const legacyBuild = await build(repo.repoRoot);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(outcome.results[0]?.artifacts).toEqual(legacyBuild[0]?.artifacts);
    expect(outcome.validation).toEqual(await validate(repo.repoRoot));
    expect(outcome.validation.passed).toBe(true);
  },
);

const references = [
  ['cursor', '.cursor-plugin/plugin.json'],
  ['codex', '.codex-plugin/plugin.json'],
  ['open-plugins', '.plugin/plugin.json'],
] as const;

it.each(references)(
  'checks readability of a %s manifest reference outside agents/',
  async (target, manifest) => {
    repo = synthRegistryRepo([
      {
        name: 'demo',
        targets: [target],
        files: {
          [manifest]: '{"name":"demo","version":"0.0.1","agents":"./custom/agent.md"}',
          'custom/agent.md': 'Demo agent',
        },
      },
    ]);
    const file = path.join(repo.repoRoot, 'plugins', 'demo', 'custom', 'agent.md');
    failRead(file);
    await build(repo.repoRoot);
    const legacy = await validate(repo.repoRoot);
    expect(legacy.passed).toBe(true);
    const outcome = await buildWithOutcome(repo.repoRoot);
    expectLegacyFindings(outcome, legacy);
    expectReadFailure(outcome, file, 'EACCES');
  },
);

it.skipIf(process.platform === 'win32').each(references)(
  'adds a read finding for a dangling %s reference and preserves the legacy missing-path finding',
  async (target, manifest) => {
    repo = synthRegistryRepo([
      {
        name: 'demo',
        targets: [target],
        files: {
          [manifest]: '{"name":"demo","version":"0.0.1","agents":"./custom/agent.md"}',
        },
      },
    ]);
    const file = path.join(repo.repoRoot, 'plugins', 'demo', 'custom', 'agent.md');
    fs.mkdirSync(path.dirname(file));
    await build(repo.repoRoot);
    const missing = await buildWithOutcome(repo.repoRoot);
    expect(readFindings(missing)).toEqual([]);
    expect(
      missing.validation.findings.some(
        ({ code, message }) => code === 'schema-invalid' && message.includes('non-existent'),
      ),
    ).toBe(true);

    fs.symlinkSync('missing.md', file);
    const outcome = await buildWithOutcome(repo.repoRoot);
    expectLegacyFindings(outcome, missing.validation);
    expectReadFailure(outcome, file, 'ENOENT');
  },
);

it.skipIf(process.platform === 'win32').each(['plugins/claude/hooks/claude.yaml', 'aipm.repo.ts'])(
  'builds with a dangling optional %s and reports its lookup failure',
  async (relative) => {
    repo = synthRegistryRepo([claude]);
    const file = path.join(repo.repoRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync('missing', file);

    const legacyBuild = await build(repo.repoRoot);
    const legacy = await validate(repo.repoRoot);
    const outcome = await buildWithOutcome(repo.repoRoot);
    expect(outcome.results.map(({ artifacts }) => artifacts)).toEqual(
      legacyBuild.map(({ artifacts }) => artifacts),
    );
    expectLegacyFindings(outcome, legacy);
    expectReadFailure(outcome, file, 'ENOENT');
  },
);

it.skipIf(process.platform === 'win32')(
  'reports a FIFO hooks source without opening it',
  () => {
    repo = synthRegistryRepo([claude]);
    const fifo = path.join(repo.repoRoot, 'plugins', 'claude', 'hooks', 'claude.yaml');
    fs.mkdirSync(path.dirname(fifo));
    const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(mkfifo.status, mkfifo.stderr).toBe(0);

    // Use the compiled entry point and a subprocess timeout so an unguarded read cannot hang Vitest.
    execFileSync('pnpm', ['exec', 'tsc', '--build'], {
      cwd: new URL('../../', import.meta.url),
      stdio: 'inherit',
    });
    const entry = new URL('../../dist/index.js', import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { buildWithOutcome } from ${JSON.stringify(entry)};
    try {
      const outcome = await buildWithOutcome(process.argv[1]);
      console.log(JSON.stringify(outcome.validation.findings));
    } catch (error) {
      console.log(error.message);
    }
  `,
        repo.repoRoot,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toMatch(/freshness-io.+expected a regular file.*claude\.yaml/);
  },
  120_000,
);
