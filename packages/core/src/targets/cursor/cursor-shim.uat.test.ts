/**
 * User-acceptance test for the Cursor controller-hook shim — the real end-to-end proof that a
 * Claude-format deny gate, translated by the generated shim, actually ENFORCES on real Cursor.
 *
 * It builds a temp workspace whose `.cursor/hooks.json` is the toolkit-generated Cursor hooks doc
 * (a `preToolUse` entry whose `command` invokes `hooks/cursor-shim.mjs` wrapping a Claude-format
 * deny handler), runs the Cursor CLI headless prompting a shell command that would `touch` a
 * marker file, and asserts the command was **blocked** — ground truth is the marker's ABSENCE, not
 * stdout scraping (spec §5, issue #37 AC8).
 *
 * Locally-automatable but not CI-runnable: it drives the real `cursor-agent` binary. When that is
 * not on `PATH`, the suite self-skips with a logged notice.
 *
 * @see docs/specs/cursor-controller-shim.md §5 (UAT)
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDir,
  emitScript,
  removeTempDir,
  resolveBinary,
} from '../../test-support/subprocess-script.js';
import { convertClaudeHooksYamlToCursorJson } from './transform.js';
import { CURSOR_SHIM_FILENAME, CURSOR_SHIM_RUNNER_SOURCE } from './shim-runner.js';

/** Whether the real Cursor CLI is available on this machine. */
const CURSOR_AGENT_AVAILABLE = resolveBinary('cursor-agent') !== undefined;

if (!CURSOR_AGENT_AVAILABLE) {
  // Logged notice (spec §5): the test is skipped, not silently passed.
  console.info(
    '[cursor-shim.uat] SKIPPED: `cursor-agent` is not on PATH — the controller-shim end-to-end ' +
      'enforcement UAT requires the real Cursor CLI (locally-automatable, not CI-runnable).',
  );
}

/**
 * Source hooks/claude.yaml: a Bash gate whose handler is a Claude-format deny gate. The handler
 * command is `${CLAUDE_PLUGIN_ROOT}`-anchored, exactly as real plugins author it (a cwd-relative
 * handler would break in the installed-plugin layout for the same reason as a cwd-relative shim
 * path — issue #56). The shim runs the handler through `sh -c`, which expands the variable from
 * the hook process environment.
 */
const SOURCE_YAML =
  'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/deny.mjs\\"" }\n';

/**
 * Build a Claude-format handler that denies every shell tool call (exit 0 with a deny decision).
 *
 * Before emitting the deny, it writes a "hook fired" marker at `firedMarker` — the positive control
 * (spec §5): its presence proves the `preToolUse` gate was actually invoked (the shim reached and
 * ran the wrapped handler), so the `touch` side-effect marker's ABSENCE means "blocked", not
 * "cursor-agent never attempted the shell command". `firedMarker` is an absolute path baked in so
 * the write does not depend on the handler's cwd.
 */
function denyHandlerSource(firedMarker: string): string {
  return `import * as fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(firedMarker)}, 'fired');
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked by controller-shim UAT',
    },
  }),
);
process.exit(0);
`;
}

describe.skipIf(!CURSOR_AGENT_AVAILABLE)('cursor-shim UAT — real Cursor enforcement', () => {
  let workspace: string | undefined;
  let pluginRoot: string | undefined;

  afterEach(() => {
    removeTempDir(workspace);
    removeTempDir(pluginRoot);
    pluginRoot = undefined;
  });

  /**
   * Emit the generated hooks doc into `<workspace>/.cursor/hooks.json` and the shim runner + deny
   * handler into `<shimRoot>/hooks/`, then run headless Cursor with `CLAUDE_PLUGIN_ROOT=<shimRoot>`
   * (the emitted command anchors the shim to `${CLAUDE_PLUGIN_ROOT}` — issue #56; Cursor sets the
   * variable for installed-plugin hooks, and the UAT provides it via the environment).
   */
  function runDenyGateScenario(ws: string, shimRoot: string) {
    const marker = path.join(ws, 'MARKER_SHOULD_NOT_EXIST');
    // Positive control: the wrapped deny handler writes this when the gate actually fires.
    const hookFiredMarker = path.join(ws, 'HOOK_FIRED');

    // Project-level Cursor hooks doc = the toolkit's generated cursor.json body (sans sentinel).
    const cursorHooks = convertClaudeHooksYamlToCursorJson(SOURCE_YAML);
    fs.mkdirSync(path.join(ws, '.cursor'), { recursive: true });
    emitScript(path.join(ws, '.cursor'), 'hooks.json', cursorHooks);

    // Emit the shim runner + the Claude-format deny handler the shim wraps.
    fs.mkdirSync(path.join(shimRoot, 'hooks'), { recursive: true });
    emitScript(path.join(shimRoot, 'hooks'), CURSOR_SHIM_FILENAME, CURSOR_SHIM_RUNNER_SOURCE);
    emitScript(path.join(shimRoot, 'hooks'), 'deny.mjs', denyHandlerSource(hookFiredMarker));

    const prompt =
      `Use the shell tool to run exactly this command and nothing else: touch ${marker}. ` +
      `Do not ask for confirmation.`;

    // Headless Cursor run. A blocked gate means the shell command never executes.
    const result = spawnSync(
      'cursor-agent',
      ['-p', prompt, '--trust', '--force', '--workspace', ws],
      {
        cwd: ws,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: shimRoot },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    return { result, marker, hookFiredMarker };
  }

  it('blocks a shell command through the generated deny gate (marker never created)', () => {
    workspace = createTempDir('aipm-cursor-uat-');
    const { result, marker, hookFiredMarker } = runDenyGateScenario(workspace, workspace);

    // Guard against a spurious pass: if cursor-agent never ran (spawn error) or was killed before
    // exiting (null status, e.g. timeout signal), the side-effect marker would be absent for the
    // WRONG reason. Require an actual completed run first. A non-zero status is fine — Cursor may
    // legitimately exit non-zero when a tool call is blocked; the point is that it ran.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();

    // Positive control (spec §5): the gate provably fired — the shim reached and ran the wrapped
    // deny handler, which wrote HOOK_FIRED. Without this, "marker absent" could mean the shell
    // command was simply never attempted rather than blocked.
    expect(fs.existsSync(hookFiredMarker)).toBe(true);

    // Ground truth: the marker's absence proves the shell tool was gated (spec §5).
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('enforces with an installed-plugin layout where cwd ≠ shim directory (issue #56)', () => {
    // Regression for issue #56: 0.7.0 emitted a cwd-relative `node ./hooks/cursor-shim.mjs …`,
    // which only worked when the hook's cwd happened to be the directory holding `hooks/` — a
    // coincidence the original UAT baked in by placing the shim inside the workspace. Real
    // installed plugins live OUTSIDE the workspace and Cursor does not guarantee hook cwd = plugin
    // root. Here the shim + handler live in a separate "installed plugin" root while cwd is the
    // workspace; the ${CLAUDE_PLUGIN_ROOT}-anchored invocation must still find the shim (positive
    // control HOOK_FIRED) and enforce the deny (marker absent). Against the pre-fix relative path,
    // this test fails at the positive control: node cannot resolve the shim from the workspace.
    workspace = createTempDir('aipm-cursor-uat-ws-');
    pluginRoot = createTempDir('aipm-cursor-uat-plugin-');
    const { result, marker, hookFiredMarker } = runDenyGateScenario(workspace, pluginRoot);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    // Positive control: the shim resolved via ${CLAUDE_PLUGIN_ROOT} and ran the wrapped handler.
    expect(fs.existsSync(hookFiredMarker)).toBe(true);
    // Ground truth: the deny still enforced with cwd ≠ shim directory.
    expect(fs.existsSync(marker)).toBe(false);
  });
});
