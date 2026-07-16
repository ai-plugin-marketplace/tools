/**
 * Shared test harness for exercising a **generated-script asset** (payload-adapter, the Cursor
 * shim runner, …) exactly as its real consumer would: written to a temp dir and driven as a
 * subprocess, not imported and called in-process.
 *
 * Consolidates what `hooks/payload-adapter.test.ts`, `targets/cursor/cursor-shim.test.ts`, and
 * `targets/cursor/cursor-shim.uat.test.ts` each re-implemented: the mkdtemp + cleanup lifecycle,
 * the `spawnSync` subprocess wrapper, and the `which`/`where` PATH probe.
 *
 * `emitScript` never chmods a file unless a caller explicitly opts in via `executable: true` — it
 * mirrors the real build's write path (`fs.writeFileSync` — mode 0o644 by default — and only
 * `fs.chmodSync(…, 0o755)` for files the build marks executable, see `pipeline/build.ts`) rather
 * than unconditionally granting the executable bit, which would mask a regression like the one
 * fixed in #53 (an emitted adapter shipping non-executable).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Create a fresh temp directory (`os.tmpdir()/<prefix><random>`) for a test suite to write into. */
export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively remove a temp directory created by {@link createTempDir}, tolerating an absent dir. */
export function removeTempDir(dir: string | undefined): void {
  if (dir !== undefined && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

/** Options for {@link emitScript}. */
export interface EmitScriptOptions {
  /**
   * When `true`, sets the executable bit (`0o755`) after writing — mirroring
   * `pipeline/build.ts`'s handling of `GeneratedFile.executable`. Omitted (the default) leaves the
   * file at `fs.writeFileSync`'s default mode, so a test that needs the real invocation path (a
   * bare `./script`, not `sh script` or `node script`) must opt in explicitly rather than the
   * harness silently granting it.
   */
  executable?: boolean;
}

/**
 * Write `source` to `<dir>/<filename>` and return its absolute path. Does not chmod unless
 * `options.executable` is `true` (see {@link EmitScriptOptions}).
 */
export function emitScript(
  dir: string,
  filename: string,
  source: string,
  options: EmitScriptOptions = {},
): string {
  const scriptPath = path.join(dir, filename);
  fs.writeFileSync(scriptPath, source, 'utf8');
  if (options.executable === true) fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Whether `scriptPath` currently carries the executable bit for its owner. */
export function isExecutable(scriptPath: string): boolean {
  return (fs.statSync(scriptPath).mode & 0o100) !== 0;
}

/** Options for {@link runScript}. */
export interface RunScriptOptions {
  /** Text piped to the subprocess's stdin. */
  input?: string;
  /**
   * Environment overrides merged onto `process.env`. A key mapped to `undefined` removes that
   * variable from the child's environment (rather than passing through the literal string
   * `"undefined"`).
   */
  env?: Record<string, string | undefined>;
  /**
   * Override `spawnSync`'s default 1 MB stdout/stderr buffer — needed when the script under test
   * can legitimately emit large output (see the cursor-shim large-stdout tests).
   */
  maxBuffer?: number;
}

/** Result of {@link runScript}: captured stdout and the subprocess exit status. */
export interface RunScriptResult {
  stdout: string;
  status: number | null;
}

/** Run `command args…` as a subprocess, feeding `options.input` on stdin, and capture the result. */
export function runScript(
  command: string,
  args: string[],
  options: RunScriptOptions = {},
): RunScriptResult {
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });
  return { stdout: result.stdout, status: result.status };
}

/**
 * Resolve a binary's absolute path via `which` (POSIX) / `where` (Windows), or `undefined` if it
 * is not on `PATH`. Used both to build a curated PATH for degraded-mode tests (jq absent) and to
 * probe for an optional real-CLI dependency (`cursor-agent`) that gates a UAT suite.
 */
export function resolveBinary(name: string): string | undefined {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined;
  const resolved = probe.stdout.trim().split('\n')[0];
  return resolved === '' || resolved === undefined ? undefined : resolved;
}
