---
'@ai-plugin-marketplace/core': minor
---

Contract-translate Cursor controller hooks with a generated fail-closed shim. The shipped Cursor
hooks transform is observer-only: a Claude-authored block/deny gate emitted through it fails OPEN on
Cursor, because the two harnesses' handler contracts diverge on tool identity (`Shell` vs `Bash`),
event casing, control-output shape, and failure default. `aipm build` now translates that contract
for gating events so controller hooks enforce correctly.

Classification is static, by event: a committed `GATING_EVENTS` set (`PreToolUse`,
`UserPromptSubmit`) is treated as controllers; `PostToolUse`/`Stop` fire after the decision point,
cannot block, and stay on the byte-identical observer path. For a gating event, each generated
`hooks/cursor.json` entry's `command` becomes `node ./hooks/cursor-shim.mjs <cursorEvent> --
<original handler command>` with `failClosed: true` (the handler keeps its own args verbatim after
the `--` boundary).

When a plugin has at least one gating-event hook, the build additionally emits a static Node runner
`hooks/cursor-shim.mjs` plus its `hooks/cursor-shim.mjs.generated` sidecar sentinel (the runner is
pure executable JS, so the sentinel lives in the companion file). The runner reads Cursor's hook
stdin, translates it to a Claude envelope (`Shell` → `Bash`, PascalCase event, `session_id` /
`tool_input.command` pass-through), spawns the handler, and translates the handler's Claude control
output back to Cursor's flat control JSON (`permissionDecision` → `permission`; `decision:"block"` +
reason → `permission:"deny"` + `agent_message`; `beforeSubmitPrompt` block →
`{ continue: false, user_message }`). It is fail-closed: a non-zero handler exit, malformed handler
output, bad arguments, or a spawn error emit a deny and exit 2, always as valid JSON. The
`cursorHooksFileSchema` now accepts `failClosed` on an entry, and all three artifacts are
freshness-checked byte-for-byte.
