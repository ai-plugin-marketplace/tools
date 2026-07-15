/**
 * The generated Cursor controller-hook shim runner (`hooks/cursor-shim.mjs`).
 *
 * A Claude-authored *controller* hook (a block/deny gate) emitted through the observer transform
 * fails OPEN on Cursor: the two harnesses' handler contracts diverge on tool identity
 * (`Shell` vs `Bash`), event casing, control-output shape, and failure default. This module holds
 * the byte-exact static Node script the build emits per plugin (once, when ≥1 gating-event hook is
 * present) to translate a gating hook's stdin/stdout contract and enforce fail-closed.
 *
 * The runner is a **static asset**: {@link CURSOR_SHIM_RUNNER_SOURCE} is a committed constant, not
 * templated per hook, so every plugin emits identical bytes and the freshness check round-trips it.
 * Because it is static (not generated from the transform's tables), {@link CURSOR_TO_CLAUDE_TOOLS}
 * is duplicated here for the TypeScript side and a test asserts it is the exact inverse of the
 * transform's `CLAUDE_TO_CURSOR_TOOLS` (spec §3.2 / §5).
 *
 * @see docs/specs/cursor-controller-shim.md §3.2 (runner contract), §4 (translation tables),
 *   §4.4 (fail-closed rules)
 */

/**
 * Committed inverse tool table (Cursor tool type → Claude tool name), the mirror of the transform's
 * `CLAUDE_TO_CURSOR_TOOLS`: `Shell → Bash`, identity for `Read`/`Write`/`Edit`/`Grep`. Unknown tool
 * names pass through unchanged (spec §4.3). Exported for the exact-inverse sync test (§5).
 */
export const CURSOR_TO_CLAUDE_TOOLS: Readonly<Record<string, string>> = {
  Shell: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
};

/** Filename of the emitted shim runner, relative to a plugin's `hooks/` directory. */
export const CURSOR_SHIM_FILENAME = 'cursor-shim.mjs';

/**
 * Byte-exact source of the emitted `hooks/cursor-shim.mjs`. A static, plugin-independent ESM Node
 * script — the committed constant the build writes verbatim (freshness compares it byte-for-byte).
 *
 * Contract (spec §3.2):
 *  1. Parse `argv`: `<cursorEvent> -- <handler> [handlerArgs...]`.
 *  2. Read Cursor's hook payload from stdin, translate Cursor → Claude (§4.1), and spawn the
 *     handler with the Claude payload piped to its stdin.
 *  3. Translate the handler's stdout back to Cursor's flat control JSON (§4.2) and print it.
 *  4. Fail closed (§4.4): a non-zero handler exit, malformed handler stdout, bad argv, spawn error,
 *     or any internal error emits a deny (`{"permission":"deny",…}`, or `{"continue":false,…}` for
 *     `beforeSubmitPrompt`) and exits 2. Output is always valid JSON; the process never throws
 *     uncaught.
 *
 * The runner carries its own copy of {@link CURSOR_TO_CLAUDE_TOOLS} — kept in sync with the
 * transform's table by the §5 test.
 */
export const CURSOR_SHIM_RUNNER_SOURCE = `// Generated Cursor controller-hook shim runner. Do not edit directly.
// Translates a Claude-authored gating hook's stdin/stdout contract to Cursor's and enforces
// fail-closed. See docs/specs/cursor-controller-shim.md (issue #37). Author the source
// hooks/claude.yaml and run "aipm build" — the sentinel lives in cursor-shim.mjs.generated.
import { spawnSync } from 'node:child_process';

// Inverse of the transform's CLAUDE_TO_CURSOR_TOOLS (Shell -> Bash; identity otherwise).
const CURSOR_TO_CLAUDE_TOOLS = {
  Shell: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
};

// The two gating Cursor events this shim handles, mapped to their Claude event names.
const CURSOR_TO_CLAUDE_EVENTS = {
  preToolUse: 'PreToolUse',
  beforeSubmitPrompt: 'UserPromptSubmit',
};

const argv = process.argv.slice(2);
const cursorEvent = argv[0];

function denyControl(reason) {
  if (cursorEvent === 'beforeSubmitPrompt') {
    return { continue: false, user_message: reason };
  }
  return { permission: 'deny', agent_message: reason };
}

function allowControl() {
  if (cursorEvent === 'beforeSubmitPrompt') {
    return { continue: true };
  }
  return { permission: 'allow' };
}

function emit(control) {
  process.stdout.write(JSON.stringify(control));
}

function failClosed(reason) {
  emit(denyControl(reason));
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// Cursor -> Claude stdin translation (spec 4.1).
function translateCursorToClaude(cursorPayload) {
  const out = Object.assign({}, cursorPayload);
  out.hook_event_name = CURSOR_TO_CLAUDE_EVENTS[cursorEvent];
  if (typeof cursorPayload.tool_name === 'string') {
    out.tool_name = CURSOR_TO_CLAUDE_TOOLS[cursorPayload.tool_name] || cursorPayload.tool_name;
  }
  if (out.session_id === undefined && typeof cursorPayload.conversation_id === 'string') {
    out.session_id = cursorPayload.conversation_id;
  }
  return out;
}

// Claude PreToolUse handler output -> Cursor preToolUse control (spec 4.2).
function interpretPreToolUse(parsed) {
  if (parsed && typeof parsed === 'object') {
    const hso = parsed.hookSpecificOutput;
    let permission;
    let agentMessage;
    let additionalContext;
    let updatedInput;
    if (hso && typeof hso === 'object') {
      const decision = hso.permissionDecision;
      if (decision === 'allow' || decision === 'deny' || decision === 'ask') permission = decision;
      if (typeof hso.permissionDecisionReason === 'string') agentMessage = hso.permissionDecisionReason;
      if (hso.additionalContext !== undefined) additionalContext = hso.additionalContext;
    }
    if (permission === undefined && parsed.decision === 'block') {
      permission = 'deny';
      if (typeof parsed.reason === 'string') agentMessage = parsed.reason;
    }
    if (permission === undefined && parsed.continue === false) {
      permission = 'deny';
    }
    if (parsed.updatedInput !== undefined) updatedInput = parsed.updatedInput;
    if (permission !== undefined) {
      const control = { permission: permission };
      if (agentMessage !== undefined) control.agent_message = agentMessage;
      if (additionalContext !== undefined) control.additional_context = additionalContext;
      if (updatedInput !== undefined) control.updated_input = updatedInput;
      return control;
    }
    if (additionalContext !== undefined) {
      return { permission: 'allow', additional_context: additionalContext };
    }
  }
  return { permission: 'allow' };
}

// Claude UserPromptSubmit handler output -> Cursor beforeSubmitPrompt control (spec 4.2).
function interpretUserPromptSubmit(parsed) {
  if (parsed && typeof parsed === 'object') {
    let additionalContext;
    const hso = parsed.hookSpecificOutput;
    if (hso && typeof hso === 'object' && hso.additionalContext !== undefined) {
      additionalContext = hso.additionalContext;
    }
    if (parsed.decision === 'block' || parsed.continue === false) {
      const control = { continue: false };
      if (typeof parsed.reason === 'string') control.user_message = parsed.reason;
      return control;
    }
    const control = { continue: true };
    if (additionalContext !== undefined) control.additional_context = additionalContext;
    return control;
  }
  return { continue: true };
}

function interpret(parsed) {
  return cursorEvent === 'beforeSubmitPrompt'
    ? interpretUserPromptSubmit(parsed)
    : interpretPreToolUse(parsed);
}

// Best-effort reason extraction from a denying handler's stdout (used when it exits non-zero).
function extractHandlerReason(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.reason === 'string') return parsed.reason;
      const hso = parsed.hookSpecificOutput;
      if (hso && typeof hso === 'object' && typeof hso.permissionDecisionReason === 'string') {
        return hso.permissionDecisionReason;
      }
    }
  } catch (_err) {
    // Not JSON — nothing to extract.
  }
  return undefined;
}

async function main() {
  // argv shape: <cursorEvent> -- <handler> [handlerArgs...]
  const sep = argv.indexOf('--');
  if (
    cursorEvent === undefined ||
    CURSOR_TO_CLAUDE_EVENTS[cursorEvent] === undefined ||
    sep < 1 ||
    sep === argv.length - 1
  ) {
    failClosed('cursor-shim: invalid arguments; expected <cursorEvent> -- <handler> [args...]');
    return;
  }
  const handler = argv.slice(sep + 1);

  let rawStdin;
  try {
    rawStdin = await readStdin();
  } catch (_err) {
    failClosed('cursor-shim: failed to read stdin');
    return;
  }

  let cursorPayload;
  try {
    cursorPayload = rawStdin.trim() === '' ? {} : JSON.parse(rawStdin);
  } catch (_err) {
    failClosed('cursor-shim: malformed Cursor payload on stdin');
    return;
  }

  const claudePayload = translateCursorToClaude(cursorPayload);

  const result = spawnSync(handler[0], handler.slice(1), {
    input: JSON.stringify(claudePayload),
    encoding: 'utf8',
  });

  // Distinguish a genuine spawn failure (the process never ran -> null status, e.g. ENOENT) from a
  // benign stdin write error (EPIPE) when a handler exits before draining stdin. Only the former is
  // a spawn failure; the latter still yields a valid exit status and stdout to translate.
  if (result.error && result.status === null) {
    failClosed('cursor-shim: handler spawn failed: ' + String(result.error.message));
    return;
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const code = result.status;

  // Fail closed on any non-zero exit (never rely on Cursor's fail-open default).
  if (code !== 0) {
    const reason = extractHandlerReason(stdout.trim());
    failClosed(reason !== undefined ? reason : 'cursor-shim: handler exited with a non-zero status');
    return;
  }

  const trimmed = stdout.trim();
  // Exit 0 with no output: the handler declined to gate -> allow / continue.
  if (trimmed === '') {
    emit(allowControl());
    process.exit(0);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_err) {
    failClosed('cursor-shim: handler emitted malformed JSON output');
    return;
  }

  emit(interpret(parsed));
  process.exit(0);
}

main().catch((err) => {
  failClosed('cursor-shim: internal error: ' + String(err && err.message ? err.message : err));
});
`;
