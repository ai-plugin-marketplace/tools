---
schemaVersion: 0.1.0
name: marketplace-authoring
description: Turn a software repo into an AI plugin marketplace with the aipm toolkit — scaffold, author, build, and validate agent plugins across Claude Code, Cursor, Codex, Gemini, and Kiro.
version: 0.1.0
---

# marketplace-authoring

Equips the agent to turn a software repo into an AI plugin marketplace using the
`@ai-plugin-marketplace` (`aipm`) toolkit, so the software and the agent plugins that drive it ship
together.

## Capabilities

- **Add marketplace support to a repo**: add `aipm.repo.ts` / `aipm.workspace.ts`, choosing
  plugin/dist roots that don't collide with the software's own directories.
- **Scaffold & author plugins**: `aipm scaffold <name>`, then author skills, commands, agents,
  hooks, and each target's manifest.
- **Build & validate**: run `aipm build` / `aipm validate`, and interpret findings
  (`envelope-adherence`, `freshness`, `marketplace-registration`, `single-artifact-host`,
  `root-artifact-collision`).

## Onboarding

When the user asks to add AI plugin marketplace support, agent plugins, or installable skills to a
repo, follow the procedure in the bundled `marketplace-authoring` skill at
`skills/marketplace-authoring/SKILL.md`.
