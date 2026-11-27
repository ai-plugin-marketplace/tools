import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeAll, expect, it } from 'vitest';

import type { BuildOutcome } from '../index.js';
import { sidecarContent } from './sentinel.js';
import { synthRegistryRepo } from '../test-support/synth-plugin.js';
import type { SynthRegistryRepo } from '../test-support/synth-plugin.js';

const core = new URL('../../dist/index.js', import.meta.url).href;
const claude = {
  name: 'demo',
  targets: ['claude'] as const,
  files: {
    '.claude-plugin/plugin.json': '{"name":"demo","version":"0.0.1"}',
    'hooks/claude.yaml': 'hooks: {}\n',
  },
};
let repo: SynthRegistryRepo | undefined;
afterEach(() => repo?.cleanup());

beforeAll(() => {
  execFileSync('pnpm', ['exec', 'tsc', '--build'], {
    cwd: new URL('../../', import.meta.url),
    stdio: 'inherit',
  });
}, 120_000);

interface Snapshot extends BuildOutcome {
  bytes: Record<string, string | Record<string, string>>;
}

function run(root: string, mode: 'legacy' | 'outcome', setup = ''): Snapshot {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import * as api from ${JSON.stringify(core)};
      const root = process.argv[1];
      const options = { failFast: true };
      ${setup}
      const outcome = ${mode === 'legacy' ? '{ results: await api.build(root, options), validation: await api.validate(root) }' : 'await api.buildWithOutcome(root, options)'};
      function read(file) {
        return fs.statSync(file).isDirectory()
          ? Object.fromEntries(fs.readdirSync(file).sort().map(name => [name, read(path.join(file, name))]))
          : fs.readFileSync(file).toString('base64');
      }
      const bytes = Object.fromEntries(outcome.results.flatMap((result) =>
        result.artifacts.map(({ path }) => [path, read(path)])));
      console.log(JSON.stringify({ ...outcome, bytes }));
      `,
      root,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout) as Snapshot;
}

function parity(root: string, setup?: string) {
  const legacy = run(root, 'legacy', setup);
  const outcome = run(root, 'outcome', setup);
  const io = outcome.validation.findings.filter(({ code }) => code === 'freshness-io');
  const artifacts = ({ results }: Snapshot) =>
    results.map(({ plugin, pluginDir, artifacts }) => ({
      plugin,
      pluginDir,
      artifacts,
    }));
  expect(artifacts(outcome)).toEqual(artifacts(legacy));
  expect(outcome.bytes).toEqual(legacy.bytes);
  expect(outcome.validation.findings.filter(({ code }) => code !== 'freshness-io')).toEqual(
    legacy.validation.findings,
  );
  expect(outcome.validation.passed).toBe(legacy.validation.passed && io.length === 0);
  return { legacy, io };
}

it.each(['directory', 'file', 'invalid'])(
  'preserves Claude commands references to a %s',
  (kind) => {
    repo = synthRegistryRepo([claude]);
    const plugin = path.join(repo.repoRoot, 'plugins/demo');
    const commands = kind === 'invalid' ? './extras\0bad' : './extras';
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin/plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '0.0.1',
        commands,
      }),
    );
    if (kind === 'directory') fs.mkdirSync(path.join(plugin, commands));
    if (kind === 'file') fs.writeFileSync(path.join(plugin, commands), 'Example command');
    // If the legacy post-build check itself reports the invalid reference, exercise the outcome
    // with its default failFast setting so we can compare the original structured finding.
    const { legacy, io } = parity(repo.repoRoot, 'options.failFast = false;');
    expect(io).toEqual([]);
    if (kind === 'invalid') {
      expect(
        legacy.validation.findings.find(({ code }) => code === 'schema-invalid')?.message,
      ).toContain(commands);
    } else {
      expect(legacy.validation.passed).toBe(true);
    }
  },
);

it.skipIf(process.platform === 'win32').each(['plugins', '.claude-plugin'])(
  'writes first-build artifacts through a symlinked %s to a sibling directory',
  (dir) => {
    repo = synthRegistryRepo([claude], { name: 'workspace' });
    const root = repo.repoRoot;
    const link = path.join(root, dir);
    const outside = fs.mkdtempSync(path.join(path.dirname(root), 'aipm-layout-'));
    try {
      const target = path.join(outside, dir);
      if (fs.existsSync(link)) fs.renameSync(link, target);
      else fs.mkdirSync(target);
      fs.symlinkSync(target, link, 'dir');
      const reset = `
        for (const file of [
          'plugins/demo/hooks/hooks.json', 'plugins/demo/hooks/hooks.json.generated',
          '.claude-plugin/marketplace.json'
        ]) fs.rmSync(path.join(root, file), { force: true });
      `;
      const { legacy, io } = parity(root, reset);
      expect(io).toEqual([]);
      expect(legacy.validation.passed).toBe(true);
      expect(Object.keys(legacy.bytes).sort()).toEqual([
        path.join(root, '.claude-plugin/marketplace.json'),
        path.join(root, 'plugins/demo/hooks/hooks.json'),
        path.join(root, 'plugins/demo/hooks/hooks.json.generated'),
      ]);
    } finally {
      fs.rmSync(outside, { recursive: true });
    }
  },
);

it.each([false, true])('reads inherited build options (unrelated getter: %s)', (withGetter) => {
  repo = synthRegistryRepo([claude]);
  const { io } = parity(
    repo.repoRoot,
    `
    const hooks = path.join(root, 'plugins/demo/hooks/hooks.json');
    fs.writeFileSync(hooks, '{"hooks":{}}');
    fs.writeFileSync(hooks + '.generated', ${JSON.stringify(sidecarContent('hooks/claude.yaml', '99.0.0'))});
    Object.setPrototypeOf(options, { forceDowngrade: true });
    if (${String(withGetter)}) {
      Object.defineProperty(options, 'unrelated', {
        enumerable: true,
        get() { throw new Error('unrelated option was read'); },
      });
    }
  `,
  );
  expect(io).toEqual([]);
  expect(
    fs.readFileSync(path.join(repo.repoRoot, 'plugins/demo/hooks/hooks.json.generated'), 'utf8'),
  ).not.toContain('99.0.0');
});

it('returns hard standalone-validation findings with failFast enabled', () => {
  repo = synthRegistryRepo([claude]);
  const skill = path.join(repo.repoRoot, 'docs/release/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: release\ndescription: Release helper\n---\nBody\n');
  const { legacy, io } = parity(repo.repoRoot);
  expect(io).toEqual([]);
  expect(legacy.validation.findings).toContainEqual(
    expect.objectContaining({ code: 'unpublished-skill-installable', severity: 'hard' }),
  );
});

it.skipIf(process.platform === 'win32').each(['archive', 'git'])(
  'ignores dangling entries outside the selected inputs in a %s repository',
  (layout) => {
    repo = synthRegistryRepo([
      {
        name: 'demo',
        targets: ['gemini'],
        files: {
          'gemini-extension.json': '{"name":"demo","version":"0.0.1"}',
          'GEMINI.md': '# Gemini',
          'commands/example.toml': 'prompt = "Example"',
        },
      },
    ]);
    const root = repo.repoRoot;
    fs.mkdirSync(path.join(root, 'docs'));
    fs.symlinkSync('missing', path.join(root, 'docs/unused.txt'));
    fs.symlinkSync('missing', path.join(root, 'plugins/demo/commands/ignore.txt'));
    fs.mkdirSync(path.join(root, 'plugins/demo/commands/folder.md'));
    fs.symlinkSync('folder.md', path.join(root, 'plugins/demo/commands/linked.md'), 'dir');
    if (layout === 'git') execFileSync('git', ['init', '--quiet'], { cwd: root });
    const { legacy, io } = parity(root);
    expect(io).toEqual([]);
    expect(legacy.validation.passed).toBe(true);
  },
);

it.skipIf(process.platform === 'win32').each(['dangling', 'unreadable', 'native import'])(
  'reports a caught %s config dependency failure with failFast enabled',
  (failure) => {
    repo = synthRegistryRepo([claude]);
    const root = repo.repoRoot;
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const plugin = path.join(root, 'plugins/demo');
    const filename = failure === 'native import' ? 'missing.mjs' : 'defaults.ts';
    const dependency = path.join(plugin, filename);
    if (failure === 'unreadable') fs.writeFileSync(dependency, 'export const value = true;');
    else fs.symlinkSync('absent', dependency);
    const specifier = failure === 'native import' ? './defaults.mjs' : './defaults.ts';
    if (failure === 'native import') {
      fs.writeFileSync(path.join(plugin, 'defaults.mjs'), `import './${filename}';`);
    }
    const config = path.join(plugin, 'aipm.config.ts');
    fs.writeFileSync(
      config,
      `try { await import('${specifier}'); } catch {}\n${fs.readFileSync(config, 'utf8')}`,
    );
    const { io } = parity(
      root,
      failure === 'unreadable'
        ? `
      const originalRead = fs.readFileSync;
      fs.readFileSync = (file, ...options) => {
        if (String(file) === ${JSON.stringify(dependency)}) {
          throw Object.assign(new Error("EACCES: permission denied, open '" + file + "'"), {
            code: 'EACCES', path: file,
          });
        }
        return originalRead(file, ...options);
      };
      syncBuiltinESMExports();
    `
        : undefined,
    );
    expect(io).toHaveLength(1);
    expect(io[0]?.severity).toBe('hard');
    expect(io[0]?.message).toContain(dependency);
    expect(io[0]?.message).toContain(failure === 'unreadable' ? 'EACCES' : 'ENOENT');
  },
);

it.skipIf(process.platform === 'win32').each(['hooks/claude.yaml', 'defaults.ts', 'nested.mjs'])(
  'terminates when a required input %s is a FIFO',
  (file) => {
    repo = synthRegistryRepo([claude]);
    const root = repo.repoRoot;
    const plugin = path.join(root, 'plugins/demo');
    const fifo = path.join(plugin, file);
    fs.rmSync(fifo, { force: true });
    execFileSync('mkfifo', [fifo]);
    if (file.endsWith('.ts') || file.endsWith('.mjs')) {
      const config = path.join(plugin, 'aipm.config.ts');
      const dependency = file.endsWith('.mjs') ? 'defaults.mjs' : file;
      if (file.endsWith('.mjs'))
        fs.writeFileSync(path.join(plugin, dependency), `import './${file}';`);
      fs.writeFileSync(config, `import './${dependency}';\n${fs.readFileSync(config, 'utf8')}`);
    }

    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { buildWithOutcome } from ${JSON.stringify(core)};
      try { await buildWithOutcome(process.argv[1]); }
      catch (error) { console.log(error.message); }
    `,
        root,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toMatch(/freshness-io:.*expected a regular file/);
    expect(probe.stdout).toContain(fifo);
  },
);
