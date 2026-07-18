---
'@ai-plugin-marketplace/core': patch
---

Fix the emitted Cursor controller-shim runner (`hooks/cursor-shim.mjs`) dropping a handler's
denial message when it gates via the top-level `continue: false` shape. Per the Claude Code hooks
contract, a `continue: false` denial carries its user-facing message in `stopReason` — `reason` is
scoped to the separate `decision: "block"` shape. The runner's `interpretPreToolUse` and
`interpretUserPromptSubmit` only ever read `parsed.reason`, so a handler following the documented
`continue`/`stopReason` contract still denied correctly but Cursor showed the user a bare,
unexplained denial.

Both interpreters now fall back `reason` → `stopReason` when translating a `continue: false`
denial to Cursor's flat control JSON (`agent_message` for `preToolUse`, `user_message` for
`beforeSubmitPrompt`), preferring `reason` if a handler sets both. The existing `decision: "block"`

- `reason` behavior is unchanged, and a `continue: false` payload with neither field still denies
  without a message and without crashing. (#57)
