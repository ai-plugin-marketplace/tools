/**
 * Subprocess UAT for issue #95: `-h`/`--help` on EVERY subcommand must print usage and exit 0
 * BEFORE any side effect — no build, no filesystem writes, no misparsing `--help` as a positional
 * argument (e.g. `aipm validate --help` treating `--help` as the target path).
 *
 * Drives the built CLI (`dist/bin.js`) as a real user would, exactly like `lint.uat.test.ts`, so
 * this exercises the compiled dispatch/argument-parsing path rather than calling `run()`
 * in-process. Each case runs in its own empty temp directory and asserts the directory is left
 * exactly as it started — the side-effect check that catches "ran a real build/write" bugs that
 * an in-memory-stream test (`run.test.ts`) cannot.
 *
 * @see docs/specs/architecture.md §8.2
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(CLI_DIR, 'dist', 'bin.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  // Real build: proves the fix is wired through the compiled artifact, not just `run()`
  // called in-process — the reported bug was only observable via the real subprocess/binary.
  execFileSync('pnpm', ['exec', 'tsc', '--build'], { cwd: CLI_DIR, stdio: 'inherit' });
}, 120_000);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-help-uat-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Subcommands that accept `[path]`/`<name>`/`<plugin>` positional or option arguments where a
 * `--help`/`-h` flag could previously either (a) be misparsed as that argument, or (b) fail to
 * short-circuit before the command's real side-effecting work — both variants of issue #95.
 */
const SUBCOMMANDS = [
  'init',
  'build',
  'validate',
  'lint',
  'scaffold',
  'migrate',
  'check-support',
  'add-target',
  'list-targets',
] as const;

describe('aipm <subcommand> --help / -h (subprocess, issue #95)', () => {
  for (const command of SUBCOMMANDS) {
    for (const flag of ['--help', '-h'] as const) {
      it(`'${command} ${flag}' prints usage, exits 0, and performs no side effect`, () => {
        const before = fs.readdirSync(tmpDir).sort();

        const { code, stdout, stderr } = runCli([command, flag], tmpDir);

        expect(code).toBe(0);
        expect(stdout).toContain('Usage:');
        expect(stdout).toContain('Commands:');
        // No misparse error (e.g. `validate` treating `--help` as an unresolvable path) and no
        // op-in-progress/failure output (e.g. a real build's artifact-count report) leaked to
        // stderr instead of a clean usage message.
        expect(stderr).toBe('');

        // The defining regression check: the subcommand must not have touched the filesystem.
        const after = fs.readdirSync(tmpDir).sort();
        expect(after).toEqual(before);
      });
    }
  }

  it("'build --help' does not run a real build (no artifact-count report, no dist output)", () => {
    const { stdout } = runCli(['build', '--help'], tmpDir);
    expect(stdout).not.toMatch(/Built \d+ plugin/);
  });

  it("'validate --help' does not misparse --help as the target path", () => {
    const { code, stdout, stderr } = runCli(['validate', '--help'], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stderr).not.toContain('validate failed');
  });

  it("'lint --help' does not run a real lint scan (no findings/diagnostics report)", () => {
    const { stdout } = runCli(['lint', '--help'], tmpDir);
    expect(stdout).not.toContain('OK — no findings.');
    expect(stdout).not.toMatch(/"diagnostics"/);
  });

  it("'scaffold --help' does not create a plugins/--help directory", () => {
    const { code, stdout } = runCli(['scaffold', '--help'], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(fs.existsSync(path.join(tmpDir, 'plugins'))).toBe(false);
  });

  it("'init --help' does not scaffold a new repo", () => {
    const { code, stdout } = runCli(['init', '--help'], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(false);
  });
});
