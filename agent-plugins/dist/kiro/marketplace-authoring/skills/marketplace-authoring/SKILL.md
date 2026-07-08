---
schemaVersion: 0.1.0
name: marketplace-authoring
description: Use when turning a software repo (or monorepo) into an AI plugin marketplace — i.e. adding agent plugins/skills that ship alongside the software and install into Claude Code, Cursor, Codex, Gemini CLI, or Kiro. Covers adding aipm to an existing repo, scaffolding and authoring plugins, building, and validating.
---

# Authoring an AI plugin marketplace with `aipm`

This skill equips you to turn a repo whose primary purpose is shipping **software** into an AI
plugin **marketplace** — so the software and the agent plugins that make it easy to drive ship and
version together — using the `@ai-plugin-marketplace` toolkit (the `aipm` CLI).

## Mental model (read first)

- **Author once per target, install natively.** Each host platform gets its own native surface;
  `aipm` does not invent a universal manifest. The targets are `claude`, `codex`, `cursor`,
  `gemini`, `kiro`, `open-plugins` (the vendor-neutral [Open Plugins](https://open-plugins.com)
  standard — an external spec `aipm` emits to, not a format it invents), and `vercel` (the
  [agentskills.io](https://agentskills.io) skills-only surface).
- **Marketplace hosts vs. single-artifact hosts.** Claude Code, Cursor, and Codex support a
  **multi-plugin marketplace** from a git repo (a generated `marketplace.json` at the repo root).
  **Gemini and Kiro have no marketplace concept** — they install one extension/power per repo from
  the repo root, so at most **one** plugin per repo may declare `gemini` (and one `kiro`).
- **Sources are committed; so are generated outputs.** `aipm build` generates registries, dist
  bundles, and (for a single Gemini/Kiro plugin) repo-root artifacts. Commit them; CI re-runs
  `aipm validate`, whose freshness check fails if they drift.

## Procedure: add marketplace support to an existing repo

1. **Add the toolkit** as a dev dependency:
   `pnpm add -D @ai-plugin-marketplace/cli @ai-plugin-marketplace/core`.

2. **Declare the embedded layout.** Add `aipm.repo.ts` at the repo root so plugin sources don't
   collide with the software's own directories (a CLI may already own `plugins/`, `dist/`, etc.):

   ```ts
   import { defineRepoConfig } from '@ai-plugin-marketplace/core';
   export default defineRepoConfig({ pluginsRoot: 'agent-plugins', distDir: 'agent-plugins/dist' });
   ```

   Pick `pluginsRoot`/`distDir` values that are free in the repo. Both must be repo-relative (no
   `..`, not absolute).

3. **Declare the marketplace.** Add `aipm.workspace.ts` at the repo root — its presence opts the
   repo into generated registries (and repo-root Gemini/Kiro artifacts):

   ```ts
   import { defineWorkspace } from '@ai-plugin-marketplace/core';
   export default defineWorkspace({
     marketplace: { name: '<repo-name>', owner: { name: '<you>' }, description: '<one line>' },
   });
   ```

4. **Scaffold a plugin:** `pnpm exec aipm scaffold <plugin-name>`. It writes a skeleton under the
   configured `pluginsRoot` and registers the plugin in the marketplace registries. Scope its
   targets in the generated `<pluginsRoot>/<name>/aipm.config.ts` (`targets: [...]`), and set
   `description`/`keywords` there — they feed the generated registry entries.

   > **Gemini/Kiro gate:** to install into Gemini or Kiro, keep the repo to a single plugin
   > declaring that target. More than one plugin declaring the same single-artifact host is a hard
   > `single-artifact-host` validation finding.

5. **Author the plugin's content** in the conventional locations inside the plugin folder:
   `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/claude.yaml`, `.mcp.json`, and each
   target's manifest. A skill's frontmatter needs `name` (matching its directory) and a
   `description` written to trigger precisely.

6. **Build and validate:** `pnpm exec aipm build` then `pnpm exec aipm validate`. Build generates
   the registries, dist bundles, and any repo-root Gemini/Kiro artifacts; validate checks schemas,
   envelope adherence, marketplace registration, and freshness. Commit sources **and** generated
   outputs together.

7. **Keep the host repo's formatter off the marketplace content.** If the repo runs Prettier (or
   similar) in CI, exclude the generated/marketplace paths (e.g. `agent-plugins/`, the generated
   `.claude-plugin/`, `.cursor-plugin/`, `.agents/`, and repo-root `gemini-extension.json` /
   `POWER.md`) — they're governed by `aipm validate`'s freshness check, not the formatter. Wire
   `aipm validate` into CI alongside the software's own checks.

## Installing the result

Consumers install per host through each tool's conventional native flow:

- **Claude Code / Cursor:** `/plugin marketplace add <owner>/<repo>` (Cursor also via Dashboard →
  Settings → Plugins → Import).
- **Codex:** `codex plugin marketplace add <owner>/<repo>`.
- **Gemini:** `gemini extensions install <repo>` (single root extension).
- **Kiro:** "Add power from GitHub" (single root power).

## Interpreting common `aipm validate` findings

- `envelope-adherence` — the plugin has artifacts for a target not in its `aipm.config.ts` `targets`
  (or is missing a declared target's required artifact). Fix the envelope or the files.
- `marketplace-registration` — for hand-authored registries, the plugin isn't listed or its
  `source` is wrong. (When `aipm.workspace.ts` is present, registries are generated, so this is a
  `freshness` finding instead — run `aipm build`.)
- `freshness` — a committed generated artifact differs from what `aipm build` would produce
  (drift or a hand-edit). Re-run `aipm build` and commit.
- `single-artifact-host` — more than one plugin declares `gemini` or `kiro`. Drop to one declarer
  per host, or drop those targets.
- `root-artifact-collision` — a repo-root file the toolkit would generate already exists and isn't
  toolkit-generated. Move/rename the conflicting file.
