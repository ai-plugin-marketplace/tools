---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

`aipm validate` (and `lint()`'s `correctness/version-consistency` rule) now fails when a declared
target's manifest `version` field (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.cursor-plugin/plugin.json`, `gemini-extension.json`, `POWER.md` frontmatter,
`.plugin/plugin.json`) does not match `aipm.config.ts`'s `version`. Installs are keyed by manifest
version, so a stale author-maintained manifest previously let a release ship with `aipm.config.ts`
bumped but the manifest still pointing at the old version — auto-update silently kept serving the
pre-release artifact. Mirrors the existing `name-consistency` check: a new `version-consistency`
`FindingCode`, hard severity, one finding per mismatched manifest.

Fixes a related scaffold bug this check surfaced: `aipm scaffold` wrote `aipm.config.ts` with
`version: '0.1.0'` while every per-target scaffolded manifest wrote `version: '0.0.1'`, so a
freshly-scaffolded plugin failed `version-consistency` immediately. `aipm scaffold` now emits
`'0.0.1'` consistently everywhere.
