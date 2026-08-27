---
'@ai-plugin-marketplace/core': minor
---

Reject a Claude manifest `hooks` reference to the auto-loaded `hooks/hooks.json`

Claude Code auto-loads `<pluginDir>/hooks/hooks.json` and refuses to load a plugin whose
`.claude-plugin/plugin.json` `hooks` field names that same file ("Duplicate hooks file detected …
The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference
additional hook files"). `aipm validate` now emits a hard `schema-invalid` finding when the `hooks`
field — a string, or any string entry when it is an array — normalizes to `hooks/hooks.json`, with
a hint to drop the reference. Claude's generated hooks artifact remains `hooks/claude.json`.
