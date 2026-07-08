---
'@ai-plugin-marketplace/cli': minor
---

Recognize the new `open-plugins` target across the CLI. `aipm list-targets` now lists
`open-plugins`, `aipm scaffold` includes it in the default envelope (emitting `.plugin/plugin.json`
and a repo-root `marketplace.json`), and `aipm add-target <plugin> open-plugins`, `aipm build`, and
`aipm validate` handle it like any other host target.
