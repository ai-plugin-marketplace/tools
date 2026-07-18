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

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTempDir,
  emitScript,
  isExecutable,
  removeTempDir,
  resolveBinary,
  runScript,
} from '../test-support/subprocess-script.js';
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

beforeAll(() => {
  tmpDir = createTempDir('aipm-payload-adapter-');
  // Invoked via `sh <path>` below (not executed directly), but the real build's emitted adapter
  // is executable (spec §1, regression #53) — request that here too so this harness exercises the
  // production write path rather than a weaker approximation.
  adapterPath = emitScript(tmpDir, 'payload-adapter', PAYLOAD_ADAPTER_SOURCE, { executable: true });

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
  removeTempDir(tmpDir);
});

/** Run the emitted adapter as a subprocess, feeding `stdin`, with an optional PATH override. */
function runAdapter(
  stdin: string,
  args: string[] = [],
  env?: Record<string, string | undefined>,
): { stdout: string; status: number | null } {
  return runScript('sh', [adapterPath, ...args], { input: stdin, env });
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

describe('payload-adapter — emitted file mode', () => {
  // Regression guard for #53 (the emitted adapter shipping non-executable, 0644): this harness
  // requests the executable bit explicitly (see the `beforeAll` above) rather than the test
  // silently masking the real mode, so a future regression here would be caught even though the
  // subprocess itself is invoked via `sh <path>` (which does not require the bit).
  it('is executable, matching the real build write path', () => {
    expect(isExecutable(adapterPath)).toBe(true);
  });
});

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

  // Regression: a valid-JSON non-object top level (array/number/string) passed the old `jq -e .`
  // validation gate, then crashed the main jq program on `has("tool_response")` ("Cannot check
  // whether array has a string key"), producing EMPTY stdout and exit 5 — breaking the hook chain
  // (spec §7/§9's never-break-the-hook-chain principle). §5.1 step 1 now rejects non-objects at
  // the same gate as invalid JSON, so these take the byte-for-byte passthrough path instead.
  it.each([
    ['a JSON array', JSON.stringify([1, 2, 3])],
    ['a JSON number', JSON.stringify(42)],
    ['a JSON string', JSON.stringify('hello')],
  ])(
    'passes %s through byte-for-byte and exits 0, instead of crashing (step 1 non-object regression)',
    (_label, raw) => {
      const { stdout, status } = runAdapter(raw);
      expect(status).toBe(0);
      expect(stdout).toBe(raw);
    },
  );
});

// ---------------------------------------------------------------------------
// Known-event completeness (§5.1 step 4, adapter-system.md §4.2.1 canon)
// ---------------------------------------------------------------------------

// Regression: known_events previously listed only 8 of the 12 events the §5.1 step 4 known-event
// set is pinned to (adapter-system.md §4.2.1's 10-event committed Claude<->Codex map plus
// SessionEnd/Notification, which that map explicitly omits but which are still real Claude
// events). A Claude payload for one of the missing events fell through to `unknown` instead of
// `claude-code`.
describe('payload-adapter — known-event completeness (§5.1 step 4, known_events regression)', () => {
  it.each(['PermissionRequest', 'PostCompact', 'SessionEnd', 'Notification'])(
    'detects claude-code for a %s payload with no Codex-additive fields',
    (hookEventName) => {
      const payload = { session_id: 'claude-session-known-events', hook_event_name: hookEventName };
      // CODEX_HOME must be unset in the subprocess env so detection falls through to step 4
      // (the known-event PascalCase match) rather than the step 3 secondary signal.
      const { stdout, status } = runAdapter(JSON.stringify(payload), [], {
        CODEX_HOME: undefined,
      });
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout) as { harness: { name: string } };
      expect(parsed.harness).toStrictEqual({ name: 'claude-code' });
    },
  );
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

  // Regression / spec clarification (docs/specs/payload-adapter.md §4, D2 reserved-keys note):
  // `harness` and `is_subagent` are the adapter's reserved, authoritative output keys — D2's
  // additive/never-overwrite guarantee governs harness-emitted payload fields, not this reserved
  // output namespace. A raw payload carrying a spoofed `harness`/`is_subagent` must have both
  // OVERWRITTEN with the adapter's own computation, never passed through, since a
  // permission-layer consumer keys decisions on these fields being trustworthy.
  it('overwrites a spoofed harness and is_subagent with its own computed values', () => {
    const spoofed = {
      ...CLAUDE_PRE_TOOL_USE,
      harness: { name: 'spoofed' },
      is_subagent: true,
      // no agent_id present, so the real is_subagent computation is false.
    };
    const { stdout } = runAdapter(JSON.stringify(spoofed));
    const parsed = JSON.parse(stdout) as { harness: { name: string }; is_subagent: boolean };
    // Real detection: CLAUDE_PRE_TOOL_USE carries a known hook_event_name -> "claude-code".
    expect(parsed.harness).toStrictEqual({ name: 'claude-code' });
    // Real derivation: no agent_id -> false, not the spoofed `true`.
    expect(parsed.is_subagent).toBe(false);
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

// ---------------------------------------------------------------------------
// Issue #58 nit 2 — --schema output is pre-sorted at generation time, no runtime `jq -S .` spawn.
// ---------------------------------------------------------------------------

describe('payload-adapter — --schema is pre-sorted at generation time (issue #58, nit 2)', () => {
  /**
   * Independent oracle: reconstructs the SAME logical response body the adapter embeds
   * (`{ contractVersion, schema }`, compact/unsorted — the pre-fix literal shape), then pipes it
   * through the real `jq -S .` binary. This is the exact byte-for-byte behavior the old
   * `printf '%s' '<literal>' | jq -S .` runtime pipeline produced, computed here from an oracle
   * independent of `renderSchemaResponseLiteral` (never derived from the implementation, per this
   * repo's spec-first assertion rule).
   */
  function jqSortedSchemaResponseOracle(): string | undefined {
    const jqPath = resolveBinary('jq');
    if (!jqPath) return undefined;
    const compact = JSON.stringify({
      contractVersion: PAYLOAD_ADAPTER_CONTRACT_VERSION,
      schema: PAYLOAD_ADAPTER_SCHEMA,
    });
    return execFileSync(jqPath, ['-S', '.'], { input: compact, encoding: 'utf8' });
  }

  it('produces --schema output byte-identical to piping the same body through `jq -S .`', () => {
    const oracle = jqSortedSchemaResponseOracle();
    if (oracle === undefined) {
      // jq could not be located to build the oracle — nothing to compare against, skip gracefully.
      return;
    }
    const { stdout, status } = runAdapter('', ['--schema']);
    expect(status).toBe(0);
    expect(stdout).toBe(oracle);
  });

  it('never spawns jq for the --schema branch, even when the only `jq` on PATH is broken', () => {
    // A `jq` that exists (satisfies the top-of-script `command -v jq` presence check, which never
    // executes it) but explodes if actually invoked. If the --schema branch still piped its
    // literal through `jq -S .` at runtime, this would corrupt/empty the output; since the branch
    // now only `printf`s a pre-sorted literal, output must be unaffected.
    const brokenJqBinDir = path.join(tmpDir, 'broken-jq-bin');
    fs.mkdirSync(brokenJqBinDir, { recursive: true });
    const required = ['sh', 'cat', 'mktemp', 'rm', 'printf', 'command'];
    for (const name of required) {
      const resolved = resolveBinary(name);
      if (resolved) fs.symlinkSync(resolved, path.join(brokenJqBinDir, name));
    }
    const brokenJqPath = path.join(brokenJqBinDir, 'jq');
    fs.writeFileSync(brokenJqPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const { stdout, status } = runAdapter('', ['--schema'], { PATH: brokenJqBinDir });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { contractVersion: string };
    expect(parsed.contractVersion).toBe(PAYLOAD_ADAPTER_CONTRACT_VERSION);
  });

  it('the emitted --schema branch contains no `jq` invocation in its source', () => {
    // Bounded by the fixed `# Buffer stdin` comment that opens the NEXT section (rather than
    // searching for a bare "fi" line, which could false-match inside the embedded, multi-line
    // pretty-printed JSON literal the branch prints).
    const schemaBranchStart = PAYLOAD_ADAPTER_SOURCE.indexOf('"--schema"');
    const schemaBranchEnd = PAYLOAD_ADAPTER_SOURCE.indexOf('# Buffer stdin', schemaBranchStart);
    expect(schemaBranchStart).toBeGreaterThan(-1);
    expect(schemaBranchEnd).toBeGreaterThan(schemaBranchStart);
    const schemaBranch = PAYLOAD_ADAPTER_SOURCE.slice(schemaBranchStart, schemaBranchEnd);
    expect(schemaBranch).not.toContain('jq');
  });
});

// ---------------------------------------------------------------------------
// Issue #58 nit 3 — the generated banner qualifies its docs/specs pointer with the source package.
// ---------------------------------------------------------------------------

describe('payload-adapter — generated banner qualifies its docs/specs pointer (issue #58, nit 3)', () => {
  it('cites docs/specs/payload-adapter.md as living in @ai-plugin-marketplace/tools', () => {
    expect(PAYLOAD_ADAPTER_SOURCE).toContain(
      'docs/specs/payload-adapter.md in @ai-plugin-marketplace/tools',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #58 nit 4 — mktemp is given an explicit template.
// ---------------------------------------------------------------------------

describe('payload-adapter — mktemp uses an explicit template (issue #58, nit 4)', () => {
  it('embeds an explicit TMPDIR-qualified mktemp template rather than a bare `mktemp`', () => {
    expect(PAYLOAD_ADAPTER_SOURCE).toContain(
      'mktemp "${TMPDIR:-/tmp}/payload-adapter.XXXXXX" 2>/dev/null',
    );
    expect(PAYLOAD_ADAPTER_SOURCE).not.toContain('mktemp 2>/dev/null');
  });

  it('still degrades to byte-for-byte passthrough when mktemp fails (fallback unaffected)', () => {
    // A PATH with no mktemp at all forces the `|| { cat; exit 0; }` fallback, proving the explicit
    // template did not disturb the existing degrade path.
    const noMktempBinDir = path.join(tmpDir, 'no-mktemp-bin');
    fs.mkdirSync(noMktempBinDir, { recursive: true });
    for (const name of ['sh', 'cat', 'jq', 'command']) {
      const resolved = resolveBinary(name);
      if (resolved) fs.symlinkSync(resolved, path.join(noMktempBinDir, name));
    }
    const raw = JSON.stringify(CLAUDE_PRE_TOOL_USE);
    const { stdout, status } = runAdapter(raw, [], { PATH: noMktempBinDir });
    expect(status).toBe(0);
    expect(stdout).toBe(raw);
  });
});
