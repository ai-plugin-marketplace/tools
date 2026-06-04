# marketplace-authoring

Equips the agent to turn a software repo into an AI plugin **marketplace** using the
`@ai-plugin-marketplace` (`aipm`) toolkit — so the software and the agent plugins/skills that make
it easy to drive ship and version together, installable into Claude Code, Cursor, Codex, Gemini
CLI, and Kiro.

## When this helps

Use this when the user wants to add agent plugins/skills to a repo, publish a marketplace from a
git repo, or "make this repo installable into <assistant>".

## What to do

To add marketplace support to the current repo:

1. Add the toolkit: `pnpm add -D @ai-plugin-marketplace/cli @ai-plugin-marketplace/core`.
2. Add `aipm.repo.ts` (relocate `pluginsRoot` / `distDir` off any directories the software already
   uses) and `aipm.workspace.ts` (marketplace `name` / `owner`) at the repo root.
3. `pnpm exec aipm scaffold <name>`, then author the plugin's `skills/<name>/SKILL.md` and each
   target's manifest.
4. `pnpm exec aipm build`, then `pnpm exec aipm validate`; commit the sources **and** the generated
   outputs.

The bundled `marketplace-authoring` skill has the full step-by-step, the native install commands
per host, and how to interpret `aipm validate` findings.
