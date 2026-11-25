---
'@ai-plugin-marketplace/core': minor
---

Write Claude hooks to the auto-loaded `hooks/hooks.json` instead of `hooks/claude.json`.

The Claude desktop app refuses to sync a plugin to remote (SSH) hosts when its `.claude-plugin/plugin.json` has a `hooks` field, and it drops `hooks/hooks.json` from the sync when that file carries keys other than `$schema`, `description` and `hooks`. Plugins wired as `"hooks": "./hooks/claude.json"` were therefore missing from remote sessions.

- `aipm build` now writes Claude's hooks to `hooks/hooks.json`, with its marker in a `hooks/hooks.json.generated` sidecar, and no longer writes `hooks/claude.json`.
- `aipm build` no longer writes a Gemini-dialect `hooks/hooks.json` into the plugin directory; Gemini reads the copy in its `dist/gemini/` bundle.
- `aipm validate` reports a hard finding for any `hooks` field in `.claude-plugin/plugin.json`, for extra top-level keys in `hooks/hooks.json`, and for a leftover `hooks/claude.json`.

- `aipm build` refuses to overwrite a `hooks/hooks.json` or `hooks/hooks.json.generated` it did not write, or either path when it is not a regular file. Port those hooks into `hooks/claude.yaml`, then remove the file and rebuild.
- `aipm build` leaves an existing `hooks/claude.json` in place, since another manifest may still point at it; `aipm validate` reports it until it is deleted.
- `aipm validate` reports a hard finding when a generated `hooks/hooks.json` remains after its `hooks/claude.yaml` is deleted, when `hooks/hooks.json` is not the object shape Claude Code reads, when it is the Gemini copy an earlier build wrote, and when `.cursor-plugin/plugin.json` points its `hooks` field at `hooks/claude.json`.
- A native `hooks/hooks.json` is accepted in Codex-only and Open Plugins-only plugins.

To migrate a plugin: remove the `hooks` field from `.claude-plugin/plugin.json`, point a Cursor manifest's `hooks` field at `./hooks/cursor.json`, run `aipm build`, check that `hooks/hooks.json` holds the same hooks, then delete `hooks/claude.json` once no manifest references it.
