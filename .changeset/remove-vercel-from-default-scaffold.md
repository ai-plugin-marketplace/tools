---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Remove `vercel` from the default set of targets a fresh `aipm scaffold`/`core.scaffold()` declares.

`vercel`'s only build artifact is an author-authored `skills/<name>/SKILL.md`, which the scaffold
never seeds — so a plugin created with the default target set declared `vercel` but emitted zero
artifacts for it anywhere on `aipm build`, while `aipm list-targets`/`aipm check-support` reported
it as fully supported. A fresh scaffold now declares every known target except `vercel`; `vercel`
remains fully supported and can still be requested explicitly via `core.scaffold(name, { targets:
[...] })` or added to an existing plugin with `aipm add-target <plugin> vercel`.
