/**
 * UAT-style tests for the `aipm` CLI dispatcher: drive `run()` with captured streams and assert
 * exit codes + output, exactly as a user invoking the binary would observe them.
 *
 * Commands that require an on-disk plugin (build/validate happy path) are exercised end-to-end by
 * the pack-install test; here we cover help/version/list-targets and the argument-error paths.
 *
 * @see docs/specs/architecture.md §8.2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './run.js';

/** A minimal in-memory WritableStream stand-in that records everything written to it. */
function makeStream(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = '';
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

/** Invoke run() with captured stdout/stderr. */
async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = makeStream();
  const err = makeStream();
  const code = await run(argv, { stdout: out.stream, stderr: err.stream });
  return { code, out: out.text(), err: err.text() };
}

const PKG_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf-8',
    ),
  ) as { version: string }
).version;

describe('aipm help/version', () => {
  it('prints help and exits 0 with no command', async () => {
    const { code, out } = await invoke([]);
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
    expect(out).toContain('aipm <command>');
  });

  it('prints help for --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, out } = await invoke([flag]);
      expect(code).toBe(0);
      expect(out).toContain('Commands:');
    }
  });

  it('documents the build --force-downgrade override in help', async () => {
    const { out } = await invoke(['--help']);
    expect(out).toContain('--force-downgrade');
  });

  it('prints the package version for --version, matching package.json', async () => {
    const { code, out } = await invoke(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toBe(PKG_VERSION);
  });
});

describe('aipm list-targets', () => {
  it('lists the known targets, one per line, and exits 0', async () => {
    const { code, out } = await invoke(['list-targets']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toEqual([
      'claude',
      'codex',
      'cursor',
      'gemini',
      'kiro',
      'open-plugins',
      'vercel',
    ]);
  });
});

describe('aipm init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scaffolds a repo into the given dir, prints the path + next steps, and exits 0', async () => {
    const target = path.join(tmpDir, 'new-repo');
    const { code, out } = await invoke(['init', target]);
    expect(code).toBe(0);
    expect(out).toContain(`Created plugin repo at ${target}`);
    expect(out).toContain('aipm scaffold');
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
  });

  // Issue #96: a directory with no local package.json under an ancestor pnpm-workspace.yaml lets
  // `pnpm add`/`pnpm install` silently target the ANCESTOR's manifest and lockfile. `aipm init`
  // must warn (to stderr, before the "Next: run pnpm install" line) when that ancestor exists.
  it('warns to stderr when an ancestor pnpm-workspace.yaml exists', async () => {
    const wsRoot = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsRoot);
    const workspaceFile = path.join(wsRoot, 'pnpm-workspace.yaml');
    fs.writeFileSync(workspaceFile, 'packages:\n  - "pkgs/*"\n');
    const target = path.join(wsRoot, 'sub', 'my-repo');

    const { code, out, err } = await invoke(['init', target]);

    expect(code).toBe(0);
    expect(err).toContain('Warning');
    expect(err).toContain(workspaceFile);
    expect(err).toContain('pnpm install');
    // Still scaffolds — the warning does not block init.
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    expect(out).toContain('Next: run `pnpm install`');
  });

  it('does not warn when there is no ancestor pnpm-workspace.yaml', async () => {
    const target = path.join(tmpDir, 'no-ancestor', 'my-repo');
    const { code, err } = await invoke(['init', target]);
    expect(code).toBe(0);
    expect(err).toBe('');
  });

  it('init --name <name> writes the marketplace name into the repo-root registries', async () => {
    const target = path.join(tmpDir, 'named-repo');
    const { code } = await invoke(['init', '--name', 'acme-ai-plugins', target]);
    expect(code).toBe(0);
    const registry = JSON.parse(
      fs.readFileSync(path.join(target, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ) as { name?: string; owner?: { name?: string }; plugins?: unknown[] };
    expect(registry.name).toBe('acme-ai-plugins');
    expect(registry.owner?.name).toBe('acme-ai-plugins');
    // --name sets the package name too.
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf-8')) as {
      name?: string;
    };
    expect(pkg.name).toBe('acme-ai-plugins');
  });

  it('init --name=<name> (equals form) is parsed and the dir argument still resolves', async () => {
    const target = path.join(tmpDir, 'named-equals');
    const { code } = await invoke(['init', '--name=acme-ai-plugins', target]);
    expect(code).toBe(0);
    const registry = JSON.parse(
      fs.readFileSync(path.join(target, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ) as { name?: string };
    expect(registry.name).toBe('acme-ai-plugins');
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
  });

  it('init --name= (empty value) fails with exit 1 and writes nothing', async () => {
    const target = path.join(tmpDir, 'empty-name');
    const { code, err } = await invoke(['init', '--name=', target]);
    expect(code).toBe(1);
    expect(err).toContain('init failed');
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(false);
  });

  it('fails (exit 1) when the target directory is non-empty', async () => {
    const target = path.join(tmpDir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x', 'utf-8');
    const { code, err } = await invoke(['init', target]);
    expect(code).toBe(1);
    expect(err).toContain('init failed');
  });

  it('init --refresh reports unchanged on a freshly scaffolded repo and exits 0', async () => {
    const target = path.join(tmpDir, 'refresh-clean');
    await invoke(['init', target]);
    const { code, out } = await invoke(['init', '--refresh', target]);
    expect(code).toBe(0);
    expect(out).toContain('unchanged');
    expect(out).toContain('.github/workflows/ci.yml');
  });

  it('init --refresh reports a conflict for a locally-modified file and leaves it (exit 0)', async () => {
    const target = path.join(tmpDir, 'refresh-conflict');
    await invoke(['init', target]);
    const ci = path.join(target, '.github/workflows/ci.yml');
    fs.writeFileSync(ci, 'name: Custom\n', 'utf-8');
    const { code, out } = await invoke(['init', '--refresh', target]);
    expect(code).toBe(0);
    expect(out).toContain('conflict');
    expect(out).toContain('--force');
    expect(fs.readFileSync(ci, 'utf-8')).toBe('name: Custom\n');
  });

  it('init --refresh --force overwrites a locally-modified file (exit 0)', async () => {
    const target = path.join(tmpDir, 'refresh-force');
    await invoke(['init', target]);
    const ci = path.join(target, '.github/workflows/ci.yml');
    const original = fs.readFileSync(ci, 'utf-8');
    fs.writeFileSync(ci, 'name: Custom\n', 'utf-8');
    const { code, out } = await invoke(['init', '--refresh', '--force', target]);
    expect(code).toBe(0);
    expect(out).toContain('overwritten');
    expect(fs.readFileSync(ci, 'utf-8')).toBe(original);
  });
});

describe('aipm build --force-downgrade (§4.3.1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-build-guard-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  /** Scaffold a minimal single cursor plugin and return its directory. */
  function writePlugin(): string {
    const pluginDir = path.join(tmpDir, 'plugins', 'guard-plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: ['cursor'],\n});\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'claude.yaml'),
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n',
      'utf-8',
    );
    return pluginDir;
  }

  /** Read the `_generated.version` stamp of a json-field artifact. */
  function stampVersion(absPath: string): string | undefined {
    const obj = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
      _generated?: { version?: unknown };
    };
    const v = obj._generated?.version;
    return typeof v === 'string' ? v : undefined;
  }

  it('build refuses (exit 1, names both versions) when the artifact was stamped by a newer toolkit', async () => {
    const pluginDir = writePlugin();
    await invoke(['build', pluginDir]);

    // Simulate a stale install: the committed cursor.json was produced by a FUTURE generator.
    const cursorJson = path.join(pluginDir, 'hooks', 'cursor.json');
    const obj = JSON.parse(fs.readFileSync(cursorJson, 'utf-8')) as {
      _generated: Record<string, unknown>;
    };
    obj._generated['version'] = '99.0.0';
    fs.writeFileSync(cursorJson, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    const { code, err } = await invoke(['build', pluginDir]);
    expect(code).toBe(1);
    expect(err).toContain('build failed');
    expect(err).toContain('99.0.0'); // names the (newer) stamped version
    expect(err).toContain('@ai-plugin-marketplace/core@'); // names the installed version too
    expect(err).toContain('--force-downgrade'); // points at the override
    // The artifact was NOT overwritten — its future stamp is intact.
    expect(stampVersion(cursorJson)).toBe('99.0.0');
  });

  it('build --force-downgrade proceeds past the guard and restamps the artifact', async () => {
    const pluginDir = writePlugin();
    await invoke(['build', pluginDir]);
    const cursorJson = path.join(pluginDir, 'hooks', 'cursor.json');
    const obj = JSON.parse(fs.readFileSync(cursorJson, 'utf-8')) as {
      _generated: Record<string, unknown>;
    };
    obj._generated['version'] = '99.0.0';
    fs.writeFileSync(cursorJson, JSON.stringify(obj, null, 2) + '\n', 'utf-8');

    // The flag must be recognized (not mistaken for the target path) and bypass the guard.
    const { err } = await invoke(['build', '--force-downgrade', pluginDir]);
    expect(err).not.toContain('build failed');
    // Restamped DOWN off the future version — the build ran and rewrote the artifact.
    expect(stampVersion(cursorJson)).not.toBe('99.0.0');
  });
});

describe('aipm build success-line ordering (issue #97)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-build-ordering-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  /**
   * Scaffold a minimal `claude`+`cursor`-target plugin whose author-maintained
   * `.claude-plugin/plugin.json` version does NOT match `aipm.config.ts`'s — a hard
   * `version-consistency` finding (issue #75) that `build`'s post-build `validate` step surfaces.
   * Cross-target checks (including version-consistency) only run for a multi-target envelope,
   * hence the second (`cursor`) target.
   */
  function writeVersionMismatchedPlugin(): string {
    const pluginDir = path.join(tmpDir, 'plugins', 'mismatch-plugin');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: ['claude', 'cursor'],\n});\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'mismatch-plugin', version: '9.9.9' }, null, 2) + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'claude.yaml'),
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./guard.sh }\n',
      'utf-8',
    );
    return pluginDir;
  }

  it('does not print "Built N plugin(s)" when the post-build validate has a hard finding', async () => {
    const pluginDir = writeVersionMismatchedPlugin();
    const { code, out } = await invoke(['build', pluginDir]);

    expect(code).toBe(1);
    expect(out).toContain('version-consistency');
    // The success summary must never appear on a failing run (issue #97) — not merely reordered
    // below the failure.
    expect(out).not.toMatch(/Built \d+ plugin/);
  });

  it('still prints "Built N plugin(s)" before validation output on a clean run', async () => {
    // A `vercel`-only plugin needs no marketplace.json registry and no hooks source (a bare
    // `skills/*/SKILL.md` satisfies its adherence + schema checks), so this is the minimal
    // fixture that reaches a genuinely passing `validate` via the real CLI.
    const pluginDir = path.join(tmpDir, 'plugins', 'clean-plugin');
    fs.mkdirSync(path.join(pluginDir, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'aipm.config.ts'),
      "import { defineConfig } from '@ai-plugin-marketplace/core';\n\nexport default defineConfig({\n  version: '0.1.0',\n  targets: ['vercel'],\n});\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill.\n---\n\nBody.\n',
      'utf-8',
    );

    const { code, out } = await invoke(['build', pluginDir]);
    expect(code).toBe(0);
    const builtIndex = out.indexOf('Built 1 plugin(s)');
    const okIndex = out.indexOf('OK — no findings.');
    expect(builtIndex).toBeGreaterThanOrEqual(0);
    expect(okIndex).toBeGreaterThan(builtIndex);
  });
});

describe('aipm migrate', () => {
  it('is a no-op and reports no-migrations-needed', async () => {
    const { code, out } = await invoke(['migrate']);
    expect(code).toBe(0);
    expect(out.trim()).toBe('no-migrations-needed');
  });
});

describe('aipm argument errors (exit code 2)', () => {
  it('rejects an unknown command', async () => {
    const { code, err } = await invoke(['frobnicate']);
    expect(code).toBe(2);
    expect(err).toContain("unknown command 'frobnicate'");
  });

  it('requires a name for scaffold', async () => {
    const { code, err } = await invoke(['scaffold']);
    expect(code).toBe(2);
    expect(err).toContain('requires a <name>');
  });

  it('requires a plugin for check-support', async () => {
    const { code, err } = await invoke(['check-support']);
    expect(code).toBe(2);
    expect(err).toContain('requires a <plugin>');
  });

  it('requires both plugin and target for add-target', async () => {
    const { code, err } = await invoke(['add-target', 'my-plugin']);
    expect(code).toBe(2);
    expect(err).toContain('requires <plugin> and <target>');
  });

  it('rejects an unknown target for add-target', async () => {
    const { code, err } = await invoke(['add-target', 'my-plugin', 'cluade']);
    expect(code).toBe(2);
    expect(err).toContain("unknown target 'cluade'");
  });
});
