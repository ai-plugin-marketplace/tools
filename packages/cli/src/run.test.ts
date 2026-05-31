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

  it('prints the package version for --version, matching package.json', async () => {
    const { code, out } = await invoke(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toBe(PKG_VERSION);
  });
});

describe('aipm list-targets', () => {
  it('lists the five known targets, one per line, and exits 0', async () => {
    const { code, out } = await invoke(['list-targets']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toEqual(['claude', 'cursor', 'gemini', 'kiro', 'vercel']);
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

  it('fails (exit 1) when the target directory is non-empty', async () => {
    const target = path.join(tmpDir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x', 'utf-8');
    const { code, err } = await invoke(['init', target]);
    expect(code).toBe(1);
    expect(err).toContain('init failed');
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
