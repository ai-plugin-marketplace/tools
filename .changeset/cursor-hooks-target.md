---
'@ai-plugin-marketplace/core': minor
---

Add a Cursor hooks build target. When a plugin's envelope includes `cursor` and it ships a
`hooks/claude.yaml` source, `aipm build` now emits a Cursor-format `hooks/cursor.json` derived
mechanically from that source — parallel to the existing `claude` → `hooks/claude.json` and
`gemini` → `hooks/hooks.json` fan-out.

The transform renames Claude events to Cursor's camelCase vocabulary (`PreToolUse` → `preToolUse`,
`PostToolUse` → `postToolUse`, `Stop` → `stop`, `UserPromptSubmit` → `beforeSubmitPrompt`),
translates matcher tool names (`Bash` → `Shell`; `Read`/`Write`/`Edit`/`Grep` identity; unmapped
matchers pass through), and reshapes Claude's nested matcher blocks into Cursor's flat
`{ command, type?, matcher? }` entries under a `{ version: 1, hooks: … }` envelope. Source events
with no Cursor equivalent are dropped. The generated file carries the standard `_generated`
sentinel and is freshness-checked like the other hook JSONs.

`aipm validate` now validates a present `hooks/cursor.json` against a strict schema (HARD
`schema-invalid` on failure), and the Cursor manifest guidance points the `hooks` field at
`./hooks/cursor.json` instead of the Claude-format `hooks/claude.json`.
