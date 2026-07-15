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
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { convertClaudeHooksYamlToCursorJson } from './transform.js';
import { CURSOR_SHIM_FILENAME, CURSOR_SHIM_RUNNER_SOURCE } from './shim-runner.js';

/** Whether the real Cursor CLI is available on this machine. */
function cursorAgentAvailable(): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cursor-agent'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim() !== '';
}

const CURSOR_AGENT_AVAILABLE = cursorAgentAvailable();

if (!CURSOR_AGENT_AVAILABLE) {
  // Logged notice (spec §5): the test is skipped, not silently passed.
  console.info(
    '[cursor-shim.uat] SKIPPED: `cursor-agent` is not on PATH — the controller-shim end-to-end ' +
      'enforcement UAT requires the real Cursor CLI (locally-automatable, not CI-runnable).',
  );
}

/** Source hooks/claude.yaml: a Bash gate whose handler is a Claude-format deny gate. */
const SOURCE_YAML =
  'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: "node ./hooks/deny.mjs" }\n';

/** A Claude-format handler that denies every shell tool call (exit 0 with a deny decision). */
const DENY_HANDLER = `process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked by controller-shim UAT',
    },
  }),
);
process.exit(0);
`;

describe.skipIf(!CURSOR_AGENT_AVAILABLE)('cursor-shim UAT — real Cursor enforcement', () => {
  let workspace: string | undefined;

  afterEach(() => {
    if (workspace && fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true });
  });

  it('blocks a shell command through the generated deny gate (marker never created)', () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-cursor-uat-'));
    const marker = path.join(workspace, 'MARKER_SHOULD_NOT_EXIST');

    // Project-level Cursor hooks doc = the toolkit's generated cursor.json body (sans sentinel).
    const cursorHooks = convertClaudeHooksYamlToCursorJson(SOURCE_YAML);
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.cursor', 'hooks.json'), cursorHooks, 'utf8');

    // Emit the shim runner + the Claude-format deny handler the shim wraps.
    fs.mkdirSync(path.join(workspace, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'hooks', CURSOR_SHIM_FILENAME),
      CURSOR_SHIM_RUNNER_SOURCE,
      'utf8',
    );
    fs.writeFileSync(path.join(workspace, 'hooks', 'deny.mjs'), DENY_HANDLER, 'utf8');

    const prompt =
      `Use the shell tool to run exactly this command and nothing else: touch ${marker}. ` +
      `Do not ask for confirmation.`;

    // Headless Cursor run. A blocked gate means the shell command never executes.
    spawnSync('cursor-agent', ['-p', prompt, '--trust', '--force', '--workspace', workspace], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120_000,
    });

    // Ground truth: the marker's absence proves the shell tool was gated (spec §5).
    expect(fs.existsSync(marker)).toBe(false);
  });
});
