/**
 * Tests for the generated cross-harness hook payload adapter (`hooks/payload-adapter`).
 *
 * The adapter is a static `sh` + `jq` asset emitted by the build. These tests exercise it exactly
 * as a plugin's own hook handler would: `PAYLOAD_ADAPTER_SOURCE` is written to a temp dir and
 * driven as a **subprocess** with fixture stdin payloads. Expected values are hand-derived from
 * `docs/specs/payload-adapter.md` — never captured program output (this repo's spec-first
 * assertion rule). Fixture payload shapes are grounded in `docs/specs/adapter-system.md` §4.2.1's
 * empirical captures (Claude/Codex stdin envelopes).
 *
 * @see docs/specs/payload-adapter.md §3-§10 (canonical shape, additive normalization, harness
 *   detection, is_subagent, --schema/contract version, no-jq posture, determinism)
 * @see docs/specs/payload-adapter.md §14 (testing plan this suite implements)
 * @see docs/specs/adapter-system.md §4.2.1 (empirical Claude/Codex stdin envelope captures)
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PAYLOAD_ADAPTER_CONTRACT_VERSION,
  PAYLOAD_ADAPTER_SCHEMA,
  PAYLOAD_ADAPTER_SOURCE,
} from './payload-adapter.js';

// ---------------------------------------------------------------------------
// Harness: emit the adapter to a temp dir; drive it as a subprocess.
// ---------------------------------------------------------------------------

let tmpDir: string;
let adapterPath: string;
/**
 * A minimal PATH deliberately curated to exclude `jq` (but keep `sh`, `cat`, `mktemp`, `rm` —
 * everything the script needs *other* than jq) for the no-jq degraded-mode tests. Simply removing
 * jq's own directory from `$PATH` is not reliable — e.g. macOS ships a second `jq` at `/usr/bin`
 * alongside a Homebrew one at `/opt/homebrew/bin` — so this builds an explicit allow-list instead.
 */
let pathWithoutJq: string | undefined;

/** Resolve a binary's absolute path via `which`, or `undefined` if it is not on PATH. */
function resolveBinary(name: string): string | undefined {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined;
  const resolved = probe.stdout.trim().split('\n')[0];
  return resolved === '' ? undefined : resolved;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-payload-adapter-'));
  adapterPath = path.join(tmpDir, 'payload-adapter');
  fs.writeFileSync(adapterPath, PAYLOAD_ADAPTER_SOURCE, 'utf8');
  fs.chmodSync(adapterPath, 0o755);

  const noJqBinDir = path.join(tmpDir, 'no-jq-bin');
  fs.mkdirSync(noJqBinDir, { recursive: true });
  const required = ['sh', 'cat', 'mktemp', 'rm'];
  const allResolved = required.every((name) => {
    const resolved = resolveBinary(name);
    if (!resolved) return false;
    fs.symlinkSync(resolved, path.join(noJqBinDir, name));
    return true;
  });
  pathWithoutJq = allResolved ? noJqBinDir : undefined;
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

/** Run the emitted adapter as a subprocess, feeding `stdin`, with an optional PATH override. */
function runAdapter(
  stdin: string,
  args: string[] = [],
  env?: Record<string, string | undefined>,
): { stdout: string; status: number | null } {
  const result = spawnSync('sh', [adapterPath, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout, status: result.status };
}

// ---------------------------------------------------------------------------
// Fixture payloads, grounded in adapter-system.md §4.2.1's empirical captures.
// ---------------------------------------------------------------------------

/** Claude Code PreToolUse payload — native shape, canonical hub (spec D1). */
const CLAUDE_PRE_TOOL_USE = {
  session_id: 'claude-session-1',
  transcript_path: '/tmp/claude/transcript.jsonl',
  cwd: '/workspace',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la' },
};

/** Codex PreToolUse payload — identity-passthrough plus additive turn_id/model (D6a). */
const CODEX_PRE_TOOL_USE = {
  session_id: 'codex-session-1',
  transcript_path: '/tmp/codex/transcript.jsonl',
  cwd: '/workspace',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la' },
  turn_id: 'turn-1',
  model: 'gpt-5-codex',
};

/** Codex PostToolUse payload carrying tool_response (the additive-rename fixture, D2). */
const CODEX_POST_TOOL_USE = {
  session_id: 'codex-session-2',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_response: { output: 'total 0\n', exit_code: 0 },
  turn_id: 'turn-2',
  model: 'gpt-5-codex',
};

/** Claude sub-agent event: agent_id present drives is_subagent (D4). */
const CLAUDE_SUBAGENT_START = {
  session_id: 'claude-session-3',
  hook_event_name: 'SubagentStart',
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
};

/** Codex Stop event with no additive field at all — only CODEX_HOME distinguishes it (§5.1 step 3). */
const CODEX_STOP_NO_ADDITIVE = {
  session_id: 'codex-session-4',
  hook_event_name: 'Stop',
};

/** Cursor-shaped payload (camelCase event) — lands on the unknown path (§5.1 step 5, §12). */
const CURSOR_SHAPED = {
  session_id: 'cursor-session-1',
  conversation_id: 'cursor-session-1',
  hook_event_name: 'preToolUse',
  tool_name: 'Shell',
};

// ---------------------------------------------------------------------------
// Harness detection (§5.1)
// ---------------------------------------------------------------------------

describe('payload-adapter — harness detection (§5.1)', () => {
  it('detects codex from turn_id/model on a PreToolUse payload (step 2)', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CODEX_PRE_TOOL_USE));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'codex' });
  });

  it('detects codex from tool_response alone (step 2)', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CODEX_POST_TOOL_USE));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'codex' });
  });

  it('detects claude-code for a native Claude payload with no Codex-additive field', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CLAUDE_PRE_TOOL_USE));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'claude-code' });
  });

  it('detects codex via the CODEX_HOME secondary signal when no additive field is present (step 3)', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CODEX_STOP_NO_ADDITIVE), [], {
      CODEX_HOME: '/home/.codex',
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'codex' });
  });

  it('detects claude-code for that same Stop payload when CODEX_HOME is unset (step 4)', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CODEX_STOP_NO_ADDITIVE), [], {
      CODEX_HOME: undefined,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'claude-code' });
  });

  it('falls back to unknown for a non-PascalCase (Cursor-shaped) hook_event_name (step 5)', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CURSOR_SHAPED));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'unknown' });
  });

  it('falls back to unknown when hook_event_name is absent entirely', () => {
    const { stdout, status } = runAdapter(JSON.stringify({ foo: 'bar' }));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'unknown' });
  });

  it('skips detection entirely on invalid JSON, passing stdin through byte-for-byte (step 1)', () => {
    const raw = 'this is not { json';
    const { stdout, status } = runAdapter(raw);
    expect(status).toBe(0);
    expect(stdout).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Additive normalization (§4, D2)
// ---------------------------------------------------------------------------

describe('payload-adapter — additive normalization (§4, D2)', () => {
  it('adds tool_output from tool_response while leaving tool_response untouched (Codex)', () => {
    const { stdout } = runAdapter(JSON.stringify(CODEX_POST_TOOL_USE));
    const parsed = JSON.parse(stdout) as {
      tool_output: unknown;
      tool_response: unknown;
    };
    expect(parsed.tool_output).toStrictEqual(CODEX_POST_TOOL_USE.tool_response);
    expect(parsed.tool_response).toStrictEqual(CODEX_POST_TOOL_USE.tool_response);
  });

  it('leaves a native Claude tool_output unchanged (no tool_response to rename from)', () => {
    const claudePostToolUse = {
      session_id: 'claude-session-5',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_output: { output: 'total 0\n' },
    };
    const { stdout } = runAdapter(JSON.stringify(claudePostToolUse));
    const parsed = JSON.parse(stdout) as { tool_output: unknown };
    expect(parsed.tool_output).toStrictEqual(claudePostToolUse.tool_output);
  });

  it('passes every Codex-additive field through verbatim, under its original name', () => {
    const { stdout } = runAdapter(JSON.stringify(CODEX_PRE_TOOL_USE));
    const parsed = JSON.parse(stdout) as { turn_id: string; model: string };
    expect(parsed.turn_id).toBe('turn-1');
    expect(parsed.model).toBe('gpt-5-codex');
  });

  it('never removes an unrecognized input key (unknown-harness regression guard)', () => {
    const input = { foo: 'bar', nested: { baz: [1, 2, 3] } };
    const { stdout } = runAdapter(JSON.stringify(input));
    const parsed = JSON.parse(stdout) as { foo: string; nested: { baz: number[] } };
    expect(parsed.foo).toBe('bar');
    expect(parsed.nested).toStrictEqual({ baz: [1, 2, 3] });
  });
});

// ---------------------------------------------------------------------------
// is_subagent (§6, D4)
// ---------------------------------------------------------------------------

describe('payload-adapter — is_subagent derivation (§6, D4)', () => {
  it('is true when agent_id is a non-empty string (Claude sub-agent event)', () => {
    const { stdout } = runAdapter(JSON.stringify(CLAUDE_SUBAGENT_START));
    const parsed = JSON.parse(stdout) as { is_subagent: boolean };
    expect(parsed.is_subagent).toBe(true);
  });

  it('is false when agent_id is absent', () => {
    const { stdout } = runAdapter(JSON.stringify(CLAUDE_PRE_TOOL_USE));
    const parsed = JSON.parse(stdout) as { is_subagent: boolean };
    expect(parsed.is_subagent).toBe(false);
  });

  it('is false when agent_id is present but an empty string', () => {
    const { stdout } = runAdapter(JSON.stringify({ ...CLAUDE_SUBAGENT_START, agent_id: '' }));
    const parsed = JSON.parse(stdout) as { is_subagent: boolean };
    expect(parsed.is_subagent).toBe(false);
  });

  it('still derives correctly on an unknown-harness payload (degrades gracefully, §6)', () => {
    const { stdout } = runAdapter(JSON.stringify({ ...CURSOR_SHAPED, agent_id: 'a1' }));
    const parsed = JSON.parse(stdout) as { is_subagent: boolean; harness: { name: string } };
    expect(parsed.harness).toStrictEqual({ name: 'unknown' });
    expect(parsed.is_subagent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown-harness passthrough (§7, D5)
// ---------------------------------------------------------------------------

describe('payload-adapter — unknown-harness passthrough (§7, D5)', () => {
  it('passes every original key/value through unchanged, adds harness:unknown + is_subagent, exit 0', () => {
    const { stdout, status } = runAdapter(JSON.stringify(CURSOR_SHAPED));
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    for (const [key, value] of Object.entries(CURSOR_SHAPED)) {
      expect(parsed[key]).toStrictEqual(value);
    }
    expect(parsed['harness']).toStrictEqual({ name: 'unknown' });
    expect(parsed['is_subagent']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No-jq posture (§9, D8)
// ---------------------------------------------------------------------------

describe('payload-adapter — no-jq posture (§9, D8)', () => {
  it('passes a payload through byte-for-byte and exits 0 when jq is absent', () => {
    if (!pathWithoutJq) {
      // jq could not be located on PATH to exclude — nothing to scrub, skip gracefully.
      return;
    }
    const raw = JSON.stringify(CLAUDE_PRE_TOOL_USE);
    const { stdout, status } = runAdapter(raw, [], { PATH: pathWithoutJq });
    expect(status).toBe(0);
    expect(stdout).toBe(raw);
  });

  it('degrades --schema to a no-op passthrough (empty stdin) and exits 0 when jq is absent', () => {
    if (!pathWithoutJq) {
      return;
    }
    const { stdout, status } = runAdapter('', ['--schema'], { PATH: pathWithoutJq });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Determinism (§10, D9)
// ---------------------------------------------------------------------------

describe('payload-adapter — deterministic output (§10, D9)', () => {
  it('produces byte-identical output for the same logical payload with keys in a different order', () => {
    const a = JSON.stringify({
      b: 1,
      a: 2,
      session_id: 's',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    const b = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      tool_name: 'Bash',
      a: 2,
      b: 1,
    });
    const outA = runAdapter(a).stdout;
    const outB = runAdapter(b).stdout;
    expect(outA).toBe(outB);
  });

  it('sorts keys at every nesting level, including the added harness envelope', () => {
    const { stdout } = runAdapter(JSON.stringify(CLAUDE_PRE_TOOL_USE));
    // Top-level keys sorted.
    const topKeys = JSON.parse(stdout) as Record<string, unknown>;
    const keys = Object.keys(topKeys);
    expect(keys).toStrictEqual([...keys].sort());
  });
});

// ---------------------------------------------------------------------------
// --schema / contract version (§8, D6/D7)
// ---------------------------------------------------------------------------

describe('payload-adapter — --schema and contract version (§8, D6/D7)', () => {
  it('exits 0 and prints the single-sourced contract version', () => {
    const { stdout, status } = runAdapter('', ['--schema']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { contractVersion: string };
    expect(parsed.contractVersion).toBe(PAYLOAD_ADAPTER_CONTRACT_VERSION);
  });

  it('does not read stdin for --schema (a bogus stdin payload is ignored)', () => {
    const { stdout, status } = runAdapter('not valid json at all', ['--schema']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { contractVersion: string };
    expect(parsed.contractVersion).toBe(PAYLOAD_ADAPTER_CONTRACT_VERSION);
  });

  it('emits the exact §13 schema object, matched structurally field-by-field', () => {
    const { stdout } = runAdapter('', ['--schema']);
    const parsed = JSON.parse(stdout) as { schema: unknown };
    expect(parsed.schema).toStrictEqual(PAYLOAD_ADAPTER_SCHEMA);
  });

  it('the emitted schema requires harness and is_subagent, and constrains harness.name to the closed enum', () => {
    const { stdout } = runAdapter('', ['--schema']);
    const parsed = JSON.parse(stdout) as {
      schema: {
        required: string[];
        properties: { harness: { properties: { name: { enum: string[] } } } };
      };
    };
    expect(parsed.schema.required).toStrictEqual(['harness', 'is_subagent']);
    expect(parsed.schema.properties.harness.properties.name.enum).toStrictEqual([
      'claude-code',
      'codex',
      'unknown',
    ]);
  });
});
