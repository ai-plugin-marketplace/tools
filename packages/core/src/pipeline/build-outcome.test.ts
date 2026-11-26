import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import ts from 'typescript';
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
  'retains hard structural findings when repo-root freshness cannot %s artifacts',
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
        if (prefix.endsWith('aipm-root-gemini-') && ++rootAttempts % 2 === 0) throw failure;
        return mkdtempSync(prefix, options);
      });
    }
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
    await expect(buildWithOutcome(repo.repoRoot, { failFast: true })).rejects.toThrow(
      /2 hard validation finding\(s\):[\s\S]+single-artifact-host:[\s\S]+freshness-io:/,
    );
  },
);

it('keeps Gemini drift when the same plugin’s Kiro freshness check fails', async () => {
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
  expect(validation.findings).toEqual([
    {
      code: 'freshness',
      severity: 'soft',
      plugin: 'dual',
      message: `Generated bundle file 'dist/${path.join('gemini', 'dual', 'GEMINI.md')}' is stale — it differs from what \`aipm build\` would produce.`,
      hint: 'run `aipm build` to regenerate the gemini bundle.',
    },
    { code: 'freshness-io', severity: 'hard', plugin: 'dual', message: failure.message },
  ]);
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
  'keeps a Gemini collision when the affected %s fails',
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
      if (prefix.endsWith('aipm-root-gemini-') && ++rootAttempts % 2 === 0 && source === 'oracle') {
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
      'root-artifact-collision',
      'freshness-io',
    ]);
    expect(validation.findings[0]?.message).toContain("'GEMINI.md' already exists");
    expect(validation.findings[1]?.message).toBe(failure.message);
    // Disarm the read injection for the next generation's ownership lookup.
    rootAttempts = 0;
    await expect(buildWithOutcome(root, { failFast: true })).rejects.toThrow(
      /2 hard validation finding\(s\):[\s\S]+root-artifact-collision:[\s\S]+freshness-io:/,
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
    expect(validation.findings).toMatchObject([
      { code: 'freshness-io', severity: 'hard', plugin: 'gem' },
    ]);
    expect(validation.findings[0]?.message).toContain('ELOOP');

    const legacy = await validate(root);
    expect(legacy.passed).toBe(true);
    expect(legacy.findings).toHaveLength(3);
    expect(
      legacy.findings.every(
        (finding) => finding.code === 'freshness' && finding.message.includes('is missing'),
      ),
    ).toBe(true);
  },
);

it('keeps drift found before and after a read error in the same bundle', async () => {
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
  expect(validation.findings).toEqual([
    expect.objectContaining({
      code: 'freshness',
      severity: 'soft',
    }),
    expect.objectContaining({
      code: 'freshness',
      severity: 'soft',
    }),
    { code: 'freshness-io', severity: 'hard', plugin: 'gem', message: failure.message },
  ]);
  expect(validation.findings[0]?.message).toContain("GEMINI.md' is stale");
  expect(validation.findings[1]?.message).toContain("gemini-extension.json' is stale");
});

it.skipIf(process.platform === 'win32')(
  'retains generation collisions and checks plugins when workspace lookup fails',
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
        expect.objectContaining({ code: 'root-artifact-collision', severity: 'hard' }),
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
      /root-artifact-collision:[\s\S]+freshness-io:.*ELOOP/,
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
    if (operation !== 'lookup') {
      const legacy = await validate(plugin);
      expect(legacy.findings).toEqual([]);
      await expect(build(plugin, { failFast: true })).resolves.toHaveLength(1);
    }

    const { validation } = await buildWithOutcome(plugin);
    expect(validation).toEqual({
      passed: false,
      findings: [
        { code: 'freshness-io', severity: 'hard', plugin: 'skills', message: failure.message },
      ],
    });
    await expect(buildWithOutcome(plugin, { failFast: true })).rejects.toThrow(
      /freshness-io: Cannot check command frontmatter/,
    );

    const agent = path.join(plugin, 'agents', 'broken.md');
    fs.mkdirSync(path.dirname(agent));
    fs.writeFileSync(agent, '---\na: [\n---\n');
    const incomplete = await buildWithOutcome(plugin);
    expect(incomplete.validation.findings).toEqual([
      expect.objectContaining({
        code: 'frontmatter-invalid',
      }),
      expect.objectContaining({ code: 'freshness-io', message: failure.message }),
    ]);
    expect(incomplete.validation.findings[0]?.message).toContain(path.join('agents', 'broken.md'));
  },
);

it('keeps bundle drift outside an unreadable subtree without reporting missing files inside it', async () => {
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
    findings: [
      expect.objectContaining({
        code: 'freshness',
        severity: 'soft',
      }),
      { code: 'freshness-io', severity: 'hard', plugin: 'gem', message: failure.message },
    ],
  });
  expect(validation.findings[0]?.message).toContain("GEMINI.md' is stale");
});

it('checks known plugins when post-build discovery cannot enumerate the plugins directory', async () => {
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

  const { validation } = await buildWithOutcome(repo.repoRoot);
  expect(validation.passed).toBe(false);
  expect(validation.findings).toMatchObject([
    { code: 'frontmatter-invalid', severity: 'hard', plugin: 'gem' },
    { code: 'freshness-io', severity: 'hard', message: failure.message },
  ]);
});

it('retains tracked root artifacts when their ownership sidecar cannot be read during generation', async () => {
  vi.stubEnv('CI', '');
  repo = geminiRepo({ name: 'workspace' });
  const root = repo.repoRoot;
  await build(root);
  const manifest = path.join(root, '.aipm', 'generated-root.json');
  const tracked = fs.readFileSync(manifest, 'utf-8');
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
  expect(validation.findings).toMatchObject([
    { code: 'freshness', severity: 'soft' },
    { code: 'freshness-io', severity: 'hard', message: failure.message },
  ]);
  expect(validation.findings[0]?.message).toContain("'GEMINI.md' is stale");
  expect(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf-8')).toBe('# Gemini\n');
  expect(readFileSync(manifest, 'utf-8')).toBe(tracked);
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
