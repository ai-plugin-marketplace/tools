import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

import { build, buildWithOutcome, validate } from '../index.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryPlugin, SynthRegistryRepo } from '../test-support/synth-plugin.js';
import * as validator from './validate.js';

let repo: SynthRegistryRepo | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  repo?.cleanup();
});

it('keeps the public FindingCode exhaustive for existing TypeScript consumers', () => {
  const file = path.join(import.meta.dirname, 'consumer.ts');
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName !== file) {
      return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return ts.createSourceFile(
      fileName,
      `import type { Finding, FindingCode, ValidationResult } from '../index.js';
      const codes: Record<FindingCode, true> = {
        'envelope-invalid': true,
        'repo-config-invalid': true,
        'envelope-adherence': true,
        'schema-invalid': true,
        'name-consistency': true,
        'version-consistency': true,
        'mcp-key-sync': true,
        'marketplace-registration': true,
        'freshness': true,
        'single-artifact-host': true,
        'root-artifact-collision': true,
        'default-marketplace-name': true,
        'frontmatter-invalid': true,
        'metadata-dir-isolation': true,
        'open-plugins-conformance': true,
        'unpublished-skill-installable': true,
      };
      export function read(result: ValidationResult, finding: Finding): boolean {
        return result.findings.every((entry) => codes[entry.code]) && codes[finding.code];
      }`,
      languageVersion,
    );
  };

  const program = ts.createProgram([file], options, host);
  const consumer = program.getSourceFile(file);
  expect(consumer).toBeDefined();
  const messages = program
    .getSemanticDiagnostics(consumer)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(messages).toEqual([]);
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
    const { results, validation } = await buildWithOutcome(repo.repoRoot);

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
    await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
      'freshness-io: ' + failure.message,
    );
    await expect(validate(repo.repoRoot)).rejects.toBe(failure);
  },
);

it.each(['compare', 'regenerate'])(
  'reports I/O when repo-root freshness cannot %s artifacts',
  async (phase) => {
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
    const failureSummary =
      'Build produced 1 hard validation finding(s):\n  [?] single-artifact-host:';
    await expect(build(repo.repoRoot, { failFast: true })).rejects.toThrow(failureSummary);
    const rootContext = path.join(repo.repoRoot, 'GEMINI.md');
    const failure = Object.assign(new Error('Cannot check the repo-root Gemini artifacts'), {
      code: 'EACCES',
      errno: -13,
      syscall: phase === 'compare' ? 'open' : 'mkdtemp',
    });
    if (phase === 'compare') {
      const readFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
        if (file === rootContext) throw failure;
        return readFileSync(file, options);
      });
    } else {
      const mkdtempSync = fs.mkdtempSync;
      let rootAttempts = 0;
      vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
        if (prefix.endsWith('aipm-root-gemini-') && ++rootAttempts % 3 === 0) throw failure;
        return mkdtempSync(prefix, options);
      });
    }
    syncBuiltinESMExports();

    const { results, validation } = await buildWithOutcome(repo.repoRoot);

    expect(results).toHaveLength(3);
    expect(validation.passed).toBe(false);
    expect(validation.findings).toContainEqual({
      code: 'freshness-io',
      severity: 'hard',
      message: failure.message,
    });
    await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
      'freshness-io: ' + failure.message,
    );
  },
);

it('reports a failed Kiro freshness check in a multi-target plugin', async () => {
  vi.stubEnv('CI', '');
  repo = synthRegistryRepo([
    {
      name: 'dual',
      targets: ['gemini', 'kiro'],
      files: {
        'gemini-extension.json': '{"name":"dual","version":"0.0.1"}',
        'GEMINI.md': '# Gemini\n',
        'POWER.md': '---\nname: dual\ndescription: Dual power\nversion: 0.0.1\n---\n# Dual\n',
      },
    },
  ]);
  const failure = Object.assign(new Error('Cannot create the Kiro freshness directory'), {
    code: 'EACCES',
    errno: -13,
    syscall: 'mkdtemp',
  });
  const mkdtempSync = fs.mkdtempSync;
  let bundleAttempts = 0;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
    if (prefix.endsWith('aipm-freshness-') && ++bundleAttempts === 2) throw failure;
    return mkdtempSync(prefix, options);
  });
  const geminiContext = path.join(repo.repoRoot, 'dist/gemini/dual/GEMINI.md');
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === geminiContext && bundleAttempts === 1) return Buffer.from('# Stale\n');
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();

  const { validation } = await buildWithOutcome(repo.repoRoot);

  expect(validation.passed).toBe(false);
  expect(validation.findings).toContainEqual({
    code: 'freshness-io',
    severity: 'hard',
    plugin: 'dual',
    message: failure.message,
  });
});

it.each([
  ['build', build, 1],
  ['buildWithOutcome', buildWithOutcome, 2],
])('runs the legacy validator from %s', async (_name, buildPlugin, runs) => {
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

  expect(runValidate).toHaveBeenCalledTimes(runs);
});

function geminiRepo(workspace?: { name: string }): SynthRegistryRepo {
  return synthRegistryRepo(
    [
      {
        name: 'gem',
        targets: ['gemini'],
        files: {
          'gemini-extension.json': '{"name":"gem","version":"0.0.1"}',
          'GEMINI.md': '# Gemini\n',
          'commands/check.toml': 'prompt = "check"\n',
        },
      },
    ],
    workspace,
  );
}

it.each(['oracle', 'sidecar'])(
  'uses legacy root validation when the Gemini %s cannot be read',
  async (source) => {
    repo = geminiRepo({ name: 'workspace' });
    const root = repo.repoRoot;
    const authorContext = path.join(root, 'GEMINI.md');
    const manifest = path.join(root, '.aipm', 'generated-root.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{"version":1,"paths":[]}\n');
    fs.writeFileSync(authorContext, '# Author-owned\n');
    const failure = Object.assign(new Error('Cannot check Gemini root freshness'), {
      code: 'EACCES',
      errno: -13,
      syscall: source === 'oracle' ? 'mkdtemp' : 'open',
    });
    let rootAttempts = 0;
    const mkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
      if (prefix.endsWith('aipm-root-gemini-') && ++rootAttempts % 3 === 0 && source === 'oracle') {
        throw failure;
      }
      return mkdtempSync(prefix, options);
    });
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === manifest && rootAttempts > 0 && rootAttempts % 2 === 0 && source === 'sidecar') {
        throw failure;
      }
      return readFileSync(file, options);
    });
    syncBuiltinESMExports();

    const { validation } = await buildWithOutcome(root);
    expect(validation.passed).toBe(false);
    expect(validation.findings.map(({ code }) => code)).toEqual([
      source === 'sidecar' ? 'root-artifact-collision' : 'freshness',
      'freshness-io',
    ]);
    expect(validation.findings[1]?.message).toBe(failure.message);
    rootAttempts = 0;
    await expect(buildWithOutcome(root, { failFast: true })).rejects.toThrow(
      'freshness-io: ' + failure.message,
    );
    expect(readFileSync(authorContext, 'utf-8')).toBe('# Author-owned\n');
  },
);

it.skipIf(process.platform === 'win32')(
  'reports a bundle symlink loop as a lookup error',
  async () => {
    vi.stubEnv('CI', '');
    repo = geminiRepo();
    const root = repo.repoRoot;
    const bundle = path.join(root, 'dist', 'gemini', 'gem');
    const mkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
      if (prefix.endsWith('aipm-freshness-') && !fs.lstatSync(bundle).isSymbolicLink()) {
        fs.rmSync(bundle, { recursive: true });
        fs.symlinkSync(path.basename(bundle), bundle);
      }
      return mkdtempSync(prefix, options);
    });
    syncBuiltinESMExports();

    const { validation } = await buildWithOutcome(root);
    expect(validation.passed).toBe(false);
    expect(validation.findings).toContainEqual(
      expect.objectContaining({ code: 'freshness-io', severity: 'hard', plugin: 'gem' }),
    );
    expect(validation.findings.find(({ code }) => code === 'freshness-io')?.message).toContain(
      'ELOOP',
    );

    const legacy = await validate(root);
    expect(validation.findings.filter(({ code }) => code !== 'freshness-io')).toEqual(
      legacy.findings,
    );
    expect(legacy.passed).toBe(true);
    expect(legacy.findings).toHaveLength(3);
    expect(
      legacy.findings.every(
        (finding) => finding.code === 'freshness' && finding.message.includes('is missing'),
      ),
    ).toBe(true);
  },
);

it('reports a failed generated-file read during bundle comparison', async () => {
  vi.stubEnv('CI', '');
  repo = geminiRepo();
  const bundle = path.join(repo.repoRoot, 'dist', 'gemini', 'gem');
  const failure = Object.assign(new Error('Cannot read the generated command'), {
    code: 'EACCES',
    errno: -13,
    syscall: 'open',
  });
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === path.join(bundle, 'commands', 'check.toml')) throw failure;
    if (
      file === path.join(bundle, 'GEMINI.md') ||
      file === path.join(bundle, 'gemini-extension.json')
    ) {
      return Buffer.from('stale bytes');
    }
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();

  const { validation } = await buildWithOutcome(repo.repoRoot);
  expect(validation.passed).toBe(false);
  expect(validation.findings).toContainEqual({
    code: 'freshness-io',
    severity: 'hard',
    plugin: 'gem',
    message: failure.message,
  });
  await expect(validate(repo.repoRoot)).rejects.toBe(failure);
});

it.skipIf(process.platform === 'win32')(
  'checks plugins when their workspace lookup fails',
  async () => {
    repo = geminiRepo({ name: 'workspace' });
    const root = repo.repoRoot;
    const workspace = path.join(root, 'aipm.workspace.ts');
    fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Author-owned\n');
    const plugin = path.join(root, 'plugins', 'gem');
    const manifest = path.join(root, '.aipm', 'generated-root.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{"version":1,"paths":[]}\n');
    const writeFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      writeFileSync(file, data, options);
      if (file === manifest) {
        fs.rmSync(workspace);
        fs.symlinkSync(path.basename(workspace), workspace);
        writeFileSync(path.join(plugin, 'commands', 'broken.md'), '---\na: [\n---\n');
      }
    });
    syncBuiltinESMExports();

    const { validation } = await buildWithOutcome(root);
    expect(validation.passed).toBe(false);
    expect(validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'frontmatter-invalid', severity: 'hard', plugin: 'gem' }),
        expect.objectContaining({
          code: 'freshness-io',
          severity: 'hard',
        }),
      ]),
    );
    expect(validation.findings.find(({ code }) => code === 'freshness-io')?.message).toContain(
      'ELOOP',
    );
    fs.rmSync(workspace);
    writeFileSync(workspace, "export default { marketplace: { name: 'workspace' } };\n");
    await expect(buildWithOutcome(root, { failFast: true })).rejects.toThrow(
      /frontmatter-invalid:[\s\S]+freshness-io:.*ELOOP/,
    );
  },
);

it.each([false, true])(
  'detects root collisions introduced after generation (failFast: %s)',
  async (failFast) => {
    vi.stubEnv('CI', '');
    repo = geminiRepo({ name: 'workspace' });
    const root = repo.repoRoot;
    const context = path.join(root, 'GEMINI.md');
    fs.writeFileSync(context, '# Author-owned\n');
    const source = path.join(root, 'plugins', 'gem', 'GEMINI.md');
    fs.rmSync(source);
    const mkdtempSync = fs.mkdtempSync;
    let rootAttempts = 0;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
      if (prefix.endsWith('aipm-root-gemini-') && ++rootAttempts === 2) {
        fs.writeFileSync(source, '# New plugin source\n');
      }
      return mkdtempSync(prefix, options);
    });
    syncBuiltinESMExports();

    const outcome = buildWithOutcome(root, { failFast });
    if (failFast) {
      await expect(outcome).rejects.toThrow(/root-artifact-collision:.*'GEMINI.md'/);
    } else {
      const { validation } = await outcome;
      expect(validation.passed).toBe(false);
      const finding = validation.findings.find(({ code }) => code === 'root-artifact-collision');
      expect(finding?.severity).toBe('hard');
      expect(finding?.message).toContain("'GEMINI.md' already exists");
    }
    expect(fs.readFileSync(context, 'utf-8')).toBe('# Author-owned\n');
  },
);

it.each(['read', 'lookup', 'scan'])(
  'reports incomplete frontmatter checks after a %s failure and keeps checking siblings',
  async (operation) => {
    repo = synthRegistryRepo([
      {
        name: 'skills',
        targets: ['vercel'],
        files: {
          'skills/example/SKILL.md':
            '---\nname: example\ndescription: Example skill\n---\n# Example\n',
          'commands/test.md': '---\na: [\n---\n',
        },
      },
    ]);
    const plugin = path.join(repo.repoRoot, 'plugins', 'skills');
    const dir = path.join(plugin, 'commands');
    const command = path.join(dir, 'test.md');
    const failure = Object.assign(new Error('Cannot check command frontmatter'), {
      code: 'EACCES',
    });
    const readFileSync = fs.readFileSync;
    const readdirSync = fs.readdirSync;
    const statSync = fs.statSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === command && operation === 'read') throw failure;
      return readFileSync(file, options);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
      if (file === dir && operation === 'scan') throw failure;
      return readdirSync(file, options) as fs.Dirent<Buffer>[];
    });
    vi.spyOn(fs, 'statSync').mockImplementation((file, options) => {
      if (file === dir && operation === 'lookup') throw failure;
      return statSync(file, options);
    });
    syncBuiltinESMExports();
    const legacy = await validate(plugin);
    expect(legacy.findings.map(({ code }) => code)).toEqual(
      operation === 'lookup' ? ['frontmatter-invalid'] : [],
    );

    const ioFinding = {
      code: 'freshness-io',
      severity: 'hard',
      plugin: 'skills',
      message: failure.message,
    };
    const { validation } = await buildWithOutcome(plugin);
    expect(validation).toEqual({
      passed: false,
      findings: [...legacy.findings, ioFinding],
    });
    await expect(buildWithOutcome(plugin, { failFast: true })).rejects.toThrow(
      /freshness-io: Cannot check command frontmatter/,
    );

    const agent = path.join(plugin, 'agents', 'broken.md');
    fs.mkdirSync(path.dirname(agent));
    fs.writeFileSync(agent, '---\na: [\n---\n');
    const incomplete = await buildWithOutcome(plugin);
    const after = await validate(plugin);
    expect(incomplete.validation.findings).toEqual([...after.findings, ioFinding]);
    expect(after.findings[0]?.message).toContain(path.join('agents', 'broken.md'));
  },
);

it('reports a failed generated-directory enumeration during bundle comparison', async () => {
  vi.stubEnv('CI', '');
  repo = geminiRepo();
  const root = repo.repoRoot;
  const bundle = path.join(root, 'dist', 'gemini', 'gem');
  const commands = path.join(bundle, 'commands');
  const failure = Object.assign(new Error('Cannot scan the generated commands'), {
    code: 'EACCES',
  });
  const mkdtempSync = fs.mkdtempSync;
  let checking = false;
  vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
    if (prefix.endsWith('aipm-freshness-')) {
      checking = true;
      fs.writeFileSync(path.join(bundle, 'GEMINI.md'), '# Stale\n');
    }
    return mkdtempSync(prefix, options);
  });
  const readdirSync = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
    if (checking && file === commands) throw failure;
    return readdirSync(file, options) as fs.Dirent<Buffer>[];
  });
  syncBuiltinESMExports();

  const { validation } = await buildWithOutcome(root);
  expect(validation).toEqual({
    passed: false,
    findings: [{ code: 'freshness-io', severity: 'hard', plugin: 'gem', message: failure.message }],
  });
  await expect(validate(root)).rejects.toBe(failure);
});

it('reports post-build discovery failure with findings from a subsequent validation', async () => {
  repo = geminiRepo();
  const plugins = path.join(repo.repoRoot, 'plugins');
  fs.writeFileSync(path.join(plugins, 'gem', 'commands', 'broken.md'), '---\na: [\n---\n');
  const failure = Object.assign(new Error('Cannot enumerate the plugins directory'), {
    code: 'EACCES',
  });
  const readdirSync = fs.readdirSync;
  let scans = 0;
  vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
    if (file === plugins && ++scans === 2) throw failure;
    return readdirSync(file, options) as fs.Dirent<Buffer>[];
  });
  syncBuiltinESMExports();

  await expect(buildWithOutcome(repo.repoRoot)).rejects.toThrow(
    /frontmatter-invalid:[\s\S]+freshness-io: Cannot enumerate the plugins directory/,
  );
});

it('uses legacy collision handling when the root ownership sidecar cannot be read', async () => {
  vi.stubEnv('CI', '');
  repo = geminiRepo({ name: 'workspace' });
  const root = repo.repoRoot;
  await build(root);
  const manifest = path.join(root, '.aipm', 'generated-root.json');
  fs.writeFileSync(path.join(root, 'plugins', 'gem', 'GEMINI.md'), '# Updated source\n');
  const failure = Object.assign(new Error('Cannot read the ownership sidecar'), { code: 'EACCES' });
  const readFileSync = fs.readFileSync;
  let reads = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === manifest && ++reads === 1) throw failure;
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();

  const { validation } = await buildWithOutcome(root);
  expect(validation.passed).toBe(false);
  expect(validation.findings).toEqual([
    expect.objectContaining({ code: 'root-artifact-collision', severity: 'hard' }),
    { code: 'freshness-io', severity: 'hard', message: failure.message },
  ]);
  expect(validation.findings[0]?.message).toContain("'GEMINI.md' already exists");
  expect(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf-8')).toBe('# Gemini\n');
  expect(JSON.parse(readFileSync(manifest, 'utf-8'))).toEqual({ version: 1, paths: [] });
});

it('documents the outcome-only diagnostic in the architecture API example', () => {
  const spec = fs.readFileSync(
    new URL('../../../../docs/specs/architecture.md', import.meta.url),
    'utf-8',
  );
  const outcome = spec
    .split('export interface BuildOutcome {')[1]
    ?.split('export interface BuildResult')[0];
  expect(outcome).toContain('findings: (Finding | BuildFreshnessIoFinding)[];');
  expect(outcome).toContain("code: 'freshness-io';");
  const findingCode = spec
    .split('export type FindingCode =')[1]
    ?.split('export interface Finding')[0];
  expect(findingCode).toBeDefined();
  expect(findingCode).not.toContain("'freshness-io'");
});

it.skipIf(process.platform === 'win32').each(['dangling', 'tracked', 'parent'])(
  'refuses writes through a %s root artifact link outside the repository',
  async (kind) => {
    repo = geminiRepo({ name: 'workspace' });
    const root = repo.repoRoot;
    const outside = fs.mkdtempSync(path.join(path.dirname(root), 'aipm-outside-'));
    try {
      const link = path.join(root, kind === 'parent' ? 'commands' : 'GEMINI.md');
      const target = path.join(outside, kind === 'parent' ? '' : 'target.md');
      if (kind === 'tracked') {
        fs.writeFileSync(target, '# Keep\n');
        const sidecar = path.join(root, '.aipm', 'generated-root.json');
        fs.mkdirSync(path.dirname(sidecar));
        fs.writeFileSync(sidecar, '{"version":1,"paths":["GEMINI.md"]}');
      }
      fs.symlinkSync(target, link);

      await expect(buildWithOutcome(root)).rejects.toThrow(
        /freshness-io:.*output path resolves outside the repository/,
      );
      expect(fs.readlinkSync(link)).toBe(target);
      if (kind === 'tracked') expect(fs.readFileSync(target, 'utf-8')).toBe('# Keep\n');
      else expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true });
    }
  },
);

it('reports an explicit plugins root occupied by a regular file', async () => {
  repo = geminiRepo();
  const root = repo.repoRoot;
  fs.writeFileSync(path.join(root, 'aipm.repo.ts'), "export default { pluginsRoot: 'bad' };");
  fs.writeFileSync(path.join(root, 'bad'), 'regular file');
  const { validation } = await buildWithOutcome(root);
  expect(validation.passed).toBe(false);
  expect(validation.findings.find((finding) => finding.code === 'freshness-io')?.message).toContain(
    'ENOTDIR',
  );
  await expect(buildWithOutcome(root, { failFast: true })).rejects.toThrow('ENOTDIR');
});

it
  .skipIf(process.platform === 'win32')
  .each(['plugins/loop', 'plugins/claude-only/agents/loop.md', 'plugins/claude-only/skills/loop'])(
  'reports a pre-existing source link loop at %s',
  async (relative) => {
    repo = claudeRepo();
    const file = path.join(repo.repoRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(path.basename(file), file);
    const { validation } = await buildWithOutcome(repo.repoRoot);
    expect(validation.passed).toBe(false);
    expect(
      validation.findings.find((finding) => finding.code === 'freshness-io')?.message,
    ).toContain('ELOOP');
    await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow('ELOOP');
  },
);

it('rejects a bundle source file occupied by a directory', async () => {
  repo = geminiRepo();
  const context = path.join(repo.repoRoot, 'plugins', 'gem', 'GEMINI.md');
  fs.rmSync(context);
  fs.mkdirSync(context);
  await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
    /expected a regular file.*GEMINI\.md/,
  );
});

function claudeRepo(): SynthRegistryRepo {
  return synthRegistryRepo([
    {
      name: 'claude-only',
      targets: ['claude'],
      files: { '.claude-plugin/plugin.json': '{"name":"claude-only","version":"0.0.1"}' },
    },
  ]);
}

it.skipIf(process.platform === 'win32')(
  'always checks source paths with extra symbol options',
  async () => {
    repo = claudeRepo();
    const agents = path.join(repo.repoRoot, 'plugins', 'claude-only', 'agents');
    fs.symlinkSync('agents', agents);
    const options = { failFast: true, [Symbol.for('@ai-plugin-marketplace/cli/build')]: false };
    await expect(buildWithOutcome(repo.repoRoot, options)).rejects.toThrow('ELOOP');
  },
);

it.each([
  'plugins/claude-only/.mcp.json',
  '.claude-plugin/marketplace.json',
  '.aipm/generated-root.json',
])('keeps legacy handling of malformed %s', async (relative) => {
  const workspace = relative.startsWith('.aipm/') ? { name: 'workspace' } : undefined;
  const legacy = workspace === undefined ? claudeRepo() : geminiRepo(workspace);
  repo = workspace === undefined ? claudeRepo() : geminiRepo(workspace);
  try {
    for (const root of [legacy.repoRoot, repo.repoRoot]) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{broken');
    }
    await build(legacy.repoRoot);
    const outcome = await buildWithOutcome(repo.repoRoot);
    expect(outcome.validation).toEqual(await validate(legacy.repoRoot));
    expect(fs.readFileSync(path.join(repo.repoRoot, relative), 'utf8')).toBe(
      fs.readFileSync(path.join(legacy.repoRoot, relative), 'utf8'),
    );
  } finally {
    legacy.cleanup();
  }
});

it('retains a malformed manifest finding when an agents scan fails', async () => {
  repo = claudeRepo();
  const plugin = path.join(repo.repoRoot, 'plugins', 'claude-only');
  const agents = path.join(plugin, 'agents');
  fs.mkdirSync(agents);
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), '{broken');
  const failure = Object.assign(new Error('Cannot enumerate agents'), { code: 'EACCES' });
  const read = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
    if (file === agents) throw failure;
    return read(file, options) as fs.Dirent<Buffer>[];
  });
  syncBuiltinESMExports();
  const { validation } = await buildWithOutcome(repo.repoRoot);
  expect(validation.passed).toBe(false);
  expect(
    validation.findings.find((finding) => finding.code === 'schema-invalid')?.message,
  ).toContain('plugin.json');
  expect(validation.findings).toContainEqual({
    code: 'freshness-io',
    message: failure.message,
    severity: 'hard',
    plugin: 'claude-only',
  });
  await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
    /schema-invalid:[\s\S]+freshness-io: Cannot enumerate agents/,
  );
});

it('retains a root collision in the rejection when orphan cleanup fails', async () => {
  repo = geminiRepo({ name: 'workspace' });
  const root = repo.repoRoot;
  const sidecar = path.join(root, '.aipm', 'generated-root.json');
  fs.mkdirSync(path.dirname(sidecar));
  fs.writeFileSync(sidecar, '{"version":1,"paths":["orphan"]}');
  fs.mkdirSync(path.join(root, 'orphan'));
  fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Author-owned\n');

  await expect(buildWithOutcome(root, { failFast: true })).rejects.toThrow(
    /EISDIR[\s\S]+root-artifact-collision:[\s\S]+GEMINI\.md/,
  );
});

it.skipIf(process.platform === 'win32')(
  'replaces broken files in its own generated bundle',
  async () => {
    repo = geminiRepo();
    const out = path.join(repo.repoRoot, 'dist', 'gemini', 'gem', 'GEMINI.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.symlinkSync(path.basename(out), out);
    const { validation } = await buildWithOutcome(repo.repoRoot, { failFast: true });
    expect(validation.passed).toBe(true);
    expect(fs.lstatSync(out).isFile()).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toBe('# Gemini\n');
  },
);

it.each([
  new URL('../../../../docs/specs/architecture.md', import.meta.url),
  new URL('../../README.md', import.meta.url),
  new URL('../../docs/core.buildwithoutcome.md', import.meta.url),
])('documents stable source inputs in %s', (file) => {
  const content = fs.readFileSync(file, 'utf-8');
  expect(content.replace(/\s+/g, ' ')).toContain(
    'source inputs stay unchanged by other processes during the call',
  );
});

it('keeps caller-owned options out of public validation state', async () => {
  repo = claudeRepo();
  const outcomeFindings = [
    { code: 'schema-invalid', severity: 'hard', plugin: 'caller', message: 'Caller finding' },
  ];
  const options = { skipFreshness: true, outcomeFindings };

  expect(await validate(repo.repoRoot, options)).toEqual({ findings: [], passed: true });
  fs.writeFileSync(
    path.join(repo.repoRoot, 'plugins', 'claude-only', '.claude-plugin', 'plugin.json'),
    '{broken',
  );
  expect(await validate(repo.repoRoot, options)).toEqual(
    await validate(repo.repoRoot, { skipFreshness: true }),
  );
  expect(outcomeFindings).toHaveLength(1);
});

it
  .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
  .each(['custom/agent.md', '.claude-plugin/plugin.json'])(
  'reports an unreadable Claude %s as an I/O finding',
  async (relative) => {
    repo = synthRegistryRepo([
      {
        name: 'test',
        targets: ['claude'],
        files: {
          '.claude-plugin/plugin.json': '{"name":"test","agents":"./custom/agent.md"}',
          'custom/agent.md': '# Agent\n',
        },
      },
    ]);
    const input = path.join(repo.repoRoot, 'plugins', 'test', relative);
    fs.chmodSync(input, 0o000);
    try {
      const { validation } = await buildWithOutcome(repo.repoRoot);
      expect(validation.passed).toBe(false);
      const io = validation.findings.find(({ code }) => code === 'freshness-io');
      expect(io).toMatchObject({ code: 'freshness-io', severity: 'hard', plugin: 'test' });
      expect(io?.message).toContain('EACCES');
      expect(io?.message).toContain(input);
      expect(validation.findings.filter(({ code }) => code !== 'freshness-io')).toEqual(
        (await validate(repo.repoRoot)).findings,
      );
      await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
        /freshness-io:.*EACCES/,
      );
    } finally {
      fs.chmodSync(input, 0o644);
    }
  },
);

it.skipIf(process.platform === 'win32').each([
  ['loop', 'broken.mdc', 'ELOOP'],
  ['dangling link', 'missing.mdc', 'ENOENT'],
  ['directory link', '.', 'EISDIR'],
])('reports a Cursor rule %s as an I/O finding', async (_kind, target, code) => {
  repo = synthRegistryRepo([
    {
      name: 'test',
      targets: ['cursor'],
      files: { '.cursor-plugin/plugin.json': '{"name":"test"}' },
    },
  ]);
  const rules = path.join(repo.repoRoot, 'plugins', 'test', 'rules');
  const link = path.join(rules, 'broken.mdc');
  fs.mkdirSync(rules);
  fs.symlinkSync(target, link);
  expect(await validate(repo.repoRoot)).toEqual({ findings: [], passed: true });
  const { validation } = await buildWithOutcome(repo.repoRoot);
  expect(validation.passed).toBe(false);
  expect(validation.findings).toMatchObject([
    {
      code: 'freshness-io',
      severity: 'hard',
      plugin: 'test',
    },
  ]);
  expect(validation.findings[0]?.message).toContain(code);
  expect(validation.findings[0]?.message).toContain(link);
});

it.skipIf(process.platform === 'win32').each(['name: false\ndescription: false', 'name: ['])(
  'keeps main validation behavior for a healthy linked Vercel skill with %j',
  async (frontmatter) => {
    repo = synthRegistryRepo([
      {
        name: 'test',
        targets: ['vercel'],
        files: { 'skills/good/SKILL.md': '---\nname: good\ndescription: A skill\n---\nBody\n' },
      },
    ]);
    const linkedSkill = path.join(repo.repoRoot, 'dist', 'linked-skill');
    fs.mkdirSync(linkedSkill, { recursive: true });
    fs.writeFileSync(path.join(linkedSkill, 'SKILL.md'), `---\n${frontmatter}\n---\nBody\n`);
    const dir = path.join(repo.repoRoot, 'plugins', 'test', 'skills', 'alias');
    fs.symlinkSync(linkedSkill, dir);
    const baseline = await validate(repo.repoRoot);
    expect(baseline).toEqual({ findings: [], passed: true });

    const { validation } = await buildWithOutcome(repo.repoRoot, { failFast: true });
    expect(validation).toEqual(baseline);
  },
);

it.skipIf(process.platform === 'win32')(
  'keeps root artifacts when a plugin has a healthy alias',
  async () => {
    repo = geminiRepo({ name: 'workspace' });
    const plugins = path.join(repo.repoRoot, 'plugins');
    fs.symlinkSync('gem', path.join(plugins, 'alias'));
    const results = await build(repo.repoRoot, { failFast: true });
    expect(results).toHaveLength(1);
    const manifest = path.join(repo.repoRoot, 'gemini-extension.json');
    const contents = fs.readFileSync(manifest, 'utf-8');

    const outcome = await buildWithOutcome(repo.repoRoot);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      plugin: 'gem',
      artifacts: results[0]?.artifacts,
    });
    expect(outcome.validation).toEqual(await validate(repo.repoRoot));
    expect(outcome.validation).toEqual({ findings: [], passed: true });
    expect(fs.readFileSync(manifest, 'utf-8')).toBe(contents);
  },
);

it('includes the published-surface findings from standalone validation', async () => {
  repo = claudeRepo();
  const skill = path.join(repo.repoRoot, '.claude', 'skills', 'release', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: release\ndescription: Release helper\n---\nBody\n');

  await build(repo.repoRoot, { failFast: true });
  const validation = await validate(repo.repoRoot);
  expect(validation.findings).toMatchObject([
    { code: 'unpublished-skill-installable', severity: 'hard' },
  ]);
  expect((await buildWithOutcome(repo.repoRoot)).validation).toEqual(validation);
  await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
    'unpublished-skill-installable',
  );
});

it.each([
  {
    name: 'Codex hooks',
    targets: ['codex'],
    files: { '.codex-plugin/plugin.json': '{"name":"test"}', 'hooks/hooks.json': '{broken' },
  },
  {
    name: 'Gemini command',
    targets: ['gemini'],
    files: {
      'gemini-extension.json': '{"name":"test","version":"0.0.1"}',
      'GEMINI.md': '# Test\n',
      'commands/check.toml': 'prompt = [\n',
    },
  },
  {
    name: 'Claude skill without a closing frontmatter fence',
    targets: ['claude'],
    files: {
      '.claude-plugin/plugin.json': '{"name":"test"}',
      'skills/test/SKILL.md': '---\nname: test\ndescription: Test\n',
    },
  },
] satisfies SynthRegistryPlugin[])(
  'keeps existing content checks for $name',
  async ({ targets, files }) => {
    repo = synthRegistryRepo([{ name: 'test', targets, files }]);
    await build(repo.repoRoot, { failFast: true });
    expect(await validate(repo.repoRoot)).toEqual({ findings: [], passed: true });
    expect((await buildWithOutcome(repo.repoRoot, { failFast: true })).validation).toEqual({
      findings: [],
      passed: true,
    });
  },
);
