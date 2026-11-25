---
'@ai-plugin-marketplace/core': minor
---

Write Claude hooks to the auto-loaded `hooks/hooks.json` instead of `hooks/claude.json`.

The Claude desktop app refuses to sync a plugin to remote (SSH) hosts when its `.claude-plugin/plugin.json` has a `hooks` field, and it drops `hooks/hooks.json` from the sync when that file carries keys other than `$schema`, `description` and `hooks`. Plugins wired as `"hooks": "./hooks/claude.json"` were therefore missing from remote sessions.

- `aipm build` now writes Claude's hooks to `hooks/hooks.json`, with its marker in a `hooks/hooks.json.generated` sidecar, and no longer writes `hooks/claude.json`.
- `aipm build` no longer writes a Gemini-dialect `hooks/hooks.json` into the plugin directory; Gemini reads the copy in its `dist/gemini/` bundle.
- `aipm validate` reports a hard finding for any `hooks` field in `.claude-plugin/plugin.json`, for extra top-level keys in `hooks/hooks.json`, and for a leftover `hooks/claude.json`.

To migrate a plugin: remove the `hooks` field from `.claude-plugin/plugin.json`, delete `hooks/claude.json`, and run `aipm build`.
