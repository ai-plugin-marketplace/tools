/**
 * Tests for the generated Cursor controller-hook shim runner (`hooks/cursor-shim.mjs`).
 *
 * The runner is a static Node asset emitted by the build. These tests exercise it exactly as
 * Cursor would: the emitted `.mjs` is written to a temp dir and driven as a **subprocess** with
 * fixture stdin, wrapping stub Claude-format handlers. Expected values are hand-derived from
 * `docs/specs/cursor-controller-shim.md` §4 (translation tables) and §4.4 (fail-closed rules) —
 * not captured from program output.
 *
 * @see docs/specs/cursor-controller-shim.md §3.2 (runner contract), §4.1/§4.2 (tables), §4.4
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_TO_CURSOR_TOOLS } from './transform.js';
import { CURSOR_SHIM_RUNNER_SOURCE, CURSOR_TO_CLAUDE_TOOLS } from './shim-runner.js';

// ---------------------------------------------------------------------------
// Harness: emit the shim + stub handlers to a temp dir; drive the shim as a subprocess.
// ---------------------------------------------------------------------------

let tmpDir: string;
let shimPath: string;

/**
 * Write a stub Claude-format handler .mjs and return the argv that invokes it: `[node, <path>]`.
 * (Cursor's generated command similarly runs handlers via `node`; a bare `.mjs` path is not
 * directly executable.)
 */
function writeHandler(name: string, body: string): string[] {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, body, 'utf8');
  return [process.execPath, p];
}

/** Drive the emitted shim: `node cursor-shim.mjs <cursorEvent> -- <handler> [args]` with stdin. */
function runShim(
  cursorEvent: string,
  handlerArgs: string[],
  stdin: string,
): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [shimPath, cursorEvent, '--', ...handlerArgs], {
    input: stdin,
    encoding: 'utf8',
    // Generous buffer so this harness can itself capture the shim's large allow-path stdout (the
    // >1MB no-truncation / maxBuffer tests) — otherwise this spawnSync would ENOBUFS-truncate it.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout, status: result.status };
}

// A handler that captures the (translated) Claude payload it receives on stdin to argv[2], then
// exits 0 with no output — used to assert the Cursor→Claude stdin translation and the allow path.
const CAPTURE_HANDLER = `import { writeFileSync } from 'node:fs';
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  writeFileSync(process.argv[2], data);
  process.exit(0);
});
`;
// Handlers with fixed Claude-format output / exit codes (they ignore stdin).
const DENY_DECISION_HANDLER = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'not allowed' } }));
process.exit(0);
`;
const BLOCK_HANDLER = `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'blocked by policy' }));
process.exit(0);
`;
const ALLOW_HANDLER = `process.exit(0);\n`;
const EXIT1_HANDLER = `process.exit(1);\n`;
const MALFORMED_HANDLER = `process.stdout.write('this is <<< not json');
process.exit(0);
`;

/** Byte size of the large allow-path payload (well over spawnSync's default 1 MB maxBuffer). */
const BIG_CONTEXT_SIZE = 2 * 1024 * 1024;
// A handler emitting a large VALID allow decision: additionalContext of BIG_CONTEXT_SIZE bytes,
// exit 0. Exercises both the no-truncation flush (§2) and the explicit maxBuffer (§3) — under the
// old 1 MB default this stdout would have set error+status=null and been misread as a spawn failure.
const BIG_ALLOW_HANDLER = `const big = 'x'.repeat(${String(BIG_CONTEXT_SIZE)});
// Flush before exit so the handler's own large stdout is not truncated (the very bug the runner
// guards against on the shim side — the stub must not reintroduce it here).
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: big } }), () => {
  process.exit(0);
});
`;

let captureHandler: string[];
let denyHandler: string[];
let blockHandler: string[];
let allowHandler: string[];
let exit1Handler: string[];
let malformedHandler: string[];
let bigAllowHandler: string[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-cursor-shim-'));
  shimPath = path.join(tmpDir, 'cursor-shim.mjs');
  fs.writeFileSync(shimPath, CURSOR_SHIM_RUNNER_SOURCE, 'utf8');
  captureHandler = writeHandler('capture.mjs', CAPTURE_HANDLER);
  denyHandler = writeHandler('deny.mjs', DENY_DECISION_HANDLER);
  blockHandler = writeHandler('block.mjs', BLOCK_HANDLER);
  allowHandler = writeHandler('allow.mjs', ALLOW_HANDLER);
  exit1Handler = writeHandler('exit1.mjs', EXIT1_HANDLER);
  malformedHandler = writeHandler('malformed.mjs', MALFORMED_HANDLER);
  bigAllowHandler = writeHandler('big-allow.mjs', BIG_ALLOW_HANDLER);
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Cursor → Claude stdin translation (§4.1)
// ---------------------------------------------------------------------------

describe('cursor-shim — Cursor → Claude stdin translation (§4.1)', () => {
  it('remaps preToolUse/Shell → PreToolUse/Bash, passes tool_input.command and session_id through', () => {
    const outFile = path.join(tmpDir, 'captured-1.json');
    const cursorStdin = JSON.stringify({
      hook_event_name: 'preToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'rm -rf /', cwd: '/tmp' },
      session_id: 'sess-1',
      conversation_id: 'sess-1',
    });
    const { status } = runShim('preToolUse', [...captureHandler, outFile], cursorStdin);
    expect(status).toBe(0);

    const claudePayload = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      hook_event_name: string;
      tool_name: string;
      tool_input: { command: string };
      session_id: string;
    };
    // §4.1: event PascalCased, Shell→Bash, tool_input intact, session_id passes through.
    expect(claudePayload.hook_event_name).toBe('PreToolUse');
    expect(claudePayload.tool_name).toBe('Bash');
    expect(claudePayload.tool_input.command).toBe('rm -rf /');
    expect(claudePayload.session_id).toBe('sess-1');
  });

  it('falls back to conversation_id when session_id is absent (§4.1)', () => {
    const outFile = path.join(tmpDir, 'captured-2.json');
    const cursorStdin = JSON.stringify({
      hook_event_name: 'preToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'ls' },
      conversation_id: 'conv-42',
    });
    runShim('preToolUse', [...captureHandler, outFile], cursorStdin);
    const claudePayload = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { session_id: string };
    expect(claudePayload.session_id).toBe('conv-42');
  });
});

// ---------------------------------------------------------------------------
// Shell fidelity — the handler command runs through a shell (§1, spec §3.2)
// ---------------------------------------------------------------------------

describe('cursor-shim — shell fidelity: handler command runs through a shell (§1)', () => {
  const preStdin = JSON.stringify({
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });

  it('expands an env-var reference in the handler command and honors its deny (§1)', () => {
    // Under real Cursor the handler arrives as one POSIX-single-quoted token; here it is a single
    // post-`--` argument that uses a shell env-var ref. The runner must run it through a shell
    // (matching Claude's `sh -c`) for `$GATE_DIR` to expand — a bare no-shell spawn would fail to
    // exec and (fail-safe) deny, masking the availability bug this guards against.
    fs.writeFileSync(path.join(tmpDir, 'envdeny.mjs'), DENY_DECISION_HANDLER, 'utf8');
    const handlerCommand = `${process.execPath} "$GATE_DIR/envdeny.mjs"`;
    const result = spawnSync(process.execPath, [shimPath, 'preToolUse', '--', handlerCommand], {
      input: preStdin,
      encoding: 'utf8',
      env: { ...process.env, GATE_DIR: tmpDir },
    });
    expect(result.status).toBe(0);
    // The env-referenced handler ran and its deny decision was honored (not a silent exec failure).
    expect(JSON.parse(result.stdout)).toStrictEqual({
      permission: 'deny',
      agent_message: 'not allowed',
    });
  });

  it('honors an allow from a handler command invoked with its own args through the shell (§1)', () => {
    // A handler command with its own args, run as one shell command string → allow is honored.
    const result = spawnSync(
      process.execPath,
      [shimPath, 'preToolUse', '--', `${process.execPath} "${allowHandler[1] ?? ''}"`],
      { input: preStdin, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toStrictEqual({ permission: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// Large stdout — neither truncated (§2) nor misread as a spawn failure (§3)
// ---------------------------------------------------------------------------

describe('cursor-shim — large stdout is fully flushed and allowed (§2/§3)', () => {
  const preStdin = JSON.stringify({
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });

  it('allows (not denies) when the handler emits >1MB of stdout (§3 explicit maxBuffer)', () => {
    // Under spawnSync's default 1 MB maxBuffer this stdout sets error+status=null, which the runner
    // would misread as a spawn failure and DENY. With the explicit 64 MB maxBuffer it is allowed.
    const { stdout, status } = runShim('preToolUse', bigAllowHandler, preStdin);
    expect(status).toBe(0);
    expect((JSON.parse(stdout) as { permission: string }).permission).toBe('allow');
  });

  it('does not truncate the allow-path stdout write — full JSON round-trips (§2)', () => {
    const { stdout } = runShim('preToolUse', bigAllowHandler, preStdin);
    // Valid, complete JSON (a truncated pipe write would fail to parse) with the full context.
    const parsed = JSON.parse(stdout) as { permission: string; additional_context: string };
    expect(parsed.permission).toBe('allow');
    expect(parsed.additional_context).toHaveLength(BIG_CONTEXT_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Claude → Cursor control-output translation (§4.2)
// ---------------------------------------------------------------------------

describe('cursor-shim — Claude → Cursor control output (§4.2, preToolUse)', () => {
  const preStdin = JSON.stringify({
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });

  it('permissionDecision:"deny" → { permission: "deny", agent_message } and exit 0', () => {
    const { stdout, status } = runShim('preToolUse', denyHandler, preStdin);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual({ permission: 'deny', agent_message: 'not allowed' });
  });

  it('decision:"block" + reason → { permission: "deny", agent_message: reason } and exit 0', () => {
    const { stdout, status } = runShim('preToolUse', blockHandler, preStdin);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual({
      permission: 'deny',
      agent_message: 'blocked by policy',
    });
  });

  it('no decision + exit 0 (empty output) → { permission: "allow" }', () => {
    const { stdout, status } = runShim('preToolUse', allowHandler, preStdin);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual({ permission: 'allow' });
  });
});

describe('cursor-shim — beforeSubmitPrompt path (§4.2)', () => {
  const promptStdin = JSON.stringify({
    hook_event_name: 'beforeSubmitPrompt',
    prompt: 'do the thing',
    session_id: 's',
  });

  it('handler block → { continue: false, user_message: reason } and exit 0', () => {
    const { stdout, status } = runShim('beforeSubmitPrompt', blockHandler, promptStdin);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual({
      continue: false,
      user_message: 'blocked by policy',
    });
  });

  it('no decision + exit 0 → { continue: true }', () => {
    const { stdout, status } = runShim('beforeSubmitPrompt', allowHandler, promptStdin);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual({ continue: true });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed matrix (§4.4)
// ---------------------------------------------------------------------------

describe('cursor-shim — fail-closed matrix (§4.4)', () => {
  const preStdin = JSON.stringify({
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });

  it('handler exit ≠ 0 → deny + exit 2 (never fail-open)', () => {
    const { stdout, status } = runShim('preToolUse', exit1Handler, preStdin);
    expect(status).toBe(2);
    expect((JSON.parse(stdout) as { permission: string }).permission).toBe('deny');
  });

  it('malformed handler stdout (exit 0) → deny + exit 2', () => {
    const { stdout, status } = runShim('preToolUse', malformedHandler, preStdin);
    expect(status).toBe(2);
    expect((JSON.parse(stdout) as { permission: string }).permission).toBe('deny');
  });

  it('bad argv (missing `--` handler) → deny + exit 2', () => {
    // No `--` separator: the runner cannot locate a handler → fail closed.
    const result = spawnSync(process.execPath, [shimPath, 'preToolUse'], {
      input: preStdin,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect((JSON.parse(result.stdout) as { permission: string }).permission).toBe('deny');
  });

  it('spawn failure (non-existent handler) → deny + exit 2', () => {
    const { stdout, status } = runShim(
      'preToolUse',
      [path.join(tmpDir, 'does-not-exist.mjs')],
      preStdin,
    );
    expect(status).toBe(2);
    expect((JSON.parse(stdout) as { permission: string }).permission).toBe('deny');
  });

  it('fail-closed on beforeSubmitPrompt uses the continue:false deny form', () => {
    const promptStdin = JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', prompt: 'x' });
    const { stdout, status } = runShim('beforeSubmitPrompt', exit1Handler, promptStdin);
    expect(status).toBe(2);
    const parsed = JSON.parse(stdout) as { continue: boolean };
    expect(parsed.continue).toBe(false);
  });

  it('always emits syntactically valid JSON on every fail-closed path', () => {
    // Every branch above parsed successfully; assert one more (malformed) explicitly here.
    const { stdout } = runShim('preToolUse', malformedHandler, preStdin);
    expect(() => {
      JSON.parse(stdout);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Committed inverse tool table — exact inverse of the transform's table (§4.3 / §5)
// ---------------------------------------------------------------------------

describe('CURSOR_TO_CLAUDE_TOOLS — exact inverse of CLAUDE_TO_CURSOR_TOOLS (§5 sync guard)', () => {
  it('has the same number of entries as CLAUDE_TO_CURSOR_TOOLS', () => {
    expect(Object.keys(CURSOR_TO_CLAUDE_TOOLS)).toHaveLength(
      Object.keys(CLAUDE_TO_CURSOR_TOOLS).length,
    );
  });

  it('maps every CLAUDE_TO_CURSOR_TOOLS[claude]=cursor back as CURSOR_TO_CLAUDE_TOOLS[cursor]=claude', () => {
    for (const [claude, cursor] of Object.entries(CLAUDE_TO_CURSOR_TOOLS)) {
      expect(CURSOR_TO_CLAUDE_TOOLS[cursor]).toBe(claude);
    }
  });

  it('maps every CURSOR_TO_CLAUDE_TOOLS[cursor]=claude back as CLAUDE_TO_CURSOR_TOOLS[claude]=cursor', () => {
    for (const [cursor, claude] of Object.entries(CURSOR_TO_CLAUDE_TOOLS)) {
      expect(CLAUDE_TO_CURSOR_TOOLS[claude]).toBe(cursor);
    }
  });
});

// ---------------------------------------------------------------------------
// Runner tool table is GENERATED from the exported const — single source of truth (§5)
// ---------------------------------------------------------------------------

/** Extract the body of the runner's `const CURSOR_TO_CLAUDE_TOOLS = { … }` literal. */
function runnerToolTableBlock(): string {
  const marker = 'const CURSOR_TO_CLAUDE_TOOLS = {';
  const start = CURSOR_SHIM_RUNNER_SOURCE.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = CURSOR_SHIM_RUNNER_SOURCE.indexOf('};', start);
  expect(end).toBeGreaterThan(start);
  return CURSOR_SHIM_RUNNER_SOURCE.slice(start, end);
}

describe('CURSOR_SHIM_RUNNER_SOURCE — inverse tool table generated from the exported const (§5)', () => {
  it('embeds exactly the mapping from CURSOR_TO_CLAUDE_TOOLS — no drift possible', () => {
    const block = runnerToolTableBlock();
    // Every exported entry appears as a JSON-quoted line in the emitted literal…
    for (const [cursor, claude] of Object.entries(CURSOR_TO_CLAUDE_TOOLS)) {
      expect(block).toContain(`"${cursor}": "${claude}"`);
    }
    // …and there are no extra entries: exactly as many mapping lines as the const has keys.
    const mappingLines = block.split('\n').filter((l) => /^ {2}"[^"]+": "[^"]+",$/.test(l));
    expect(mappingLines).toHaveLength(Object.keys(CURSOR_TO_CLAUDE_TOOLS).length);
  });

  it('emits the table with stable, sorted key order (byte-deterministic .mjs)', () => {
    const block = runnerToolTableBlock();
    const keys = [...block.matchAll(/ {2}"([^"]+)":/g)].map((m) => m[1]);
    expect(keys.length).toBe(Object.keys(CURSOR_TO_CLAUDE_TOOLS).length);
    expect(keys).toStrictEqual([...keys].sort());
  });
});
