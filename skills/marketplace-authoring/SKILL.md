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
- **`aipm` owns what ships, and nothing else.** A plugin under `pluginsRoot` is published to
  users. A skill for the repo's own contributors (how to run the project locally, how to cut a
  release) is not `aipm`'s to manage: it stays in the host's project-local folder (for example
  `.claude/skills/`), where the host loads it for anyone working in the repo. `aipm` only checks
  that such skills don't leak to users and that published plugins don't depend on them.
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

4. **Inventory the skills the repo already has, and decide who each one is for.** List every
   existing `SKILL.md` (commonly under `.claude/skills/` or `.agents/skills/`) and make an explicit
   choice for each one before scaffolding anything:
   - **For users** if it would help someone who installed the software but never cloned this
     repo. It belongs inside a published plugin (step 6).
   - **For contributors** if it relies on repo-internal paths, scripts, release steps or CI. Leave
     it where it is and add this to its frontmatter, which hides it from the `skills` CLI:

     ```yaml
     metadata:
       internal: true
     ```

   - If one skill does both, split it. If you can't tell, ask the maintainer; don't guess.

   Never move a contributor skill into `pluginsRoot`, and never mark a user-facing skill internal,
   just to make a validation finding go away. Either one clears the finding and causes the problem
   it was warning about.

5. **Scaffold a plugin:** `pnpm exec aipm scaffold <plugin-name>`. It writes a skeleton under the
   configured `pluginsRoot` and registers the plugin in the marketplace registries. Scope its
   targets in the generated `<pluginsRoot>/<name>/aipm.config.ts` (`targets: [...]`), and set
   `description`/`keywords` there — they feed the generated registry entries.

   > **Gemini/Kiro gate:** to install into Gemini or Kiro, keep the repo to a single plugin
   > declaring that target. More than one plugin declaring the same single-artifact host is a hard
   > `single-artifact-host` validation finding.

6. **Author the plugin's content** in the conventional locations inside the plugin folder:
   `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/claude.yaml`, `.mcp.json`, and each
   target's manifest. A skill's frontmatter needs `name` (matching its directory) and a
   `description` written to trigger precisely. A plugin is installed on its own, so everything it
   needs must live inside its folder: don't link to files elsewhere in the repo, and don't tell
   the model to use a contributor skill. If published content needs something a contributor skill
   has, move that part into the plugin.

7. **Build and validate:** `pnpm exec aipm build` then `pnpm exec aipm validate`. Build generates
   the registries, dist bundles, and any repo-root Gemini/Kiro artifacts; validate checks schemas,
   envelope adherence, marketplace registration, and freshness. Commit sources **and** generated
   outputs together.

8. **Check the result as a user would, outside the repo.** Inside the repo, contributor skills
   load automatically and can make a published skill look like it works when it doesn't. Create an
   empty directory elsewhere, install the plugin there through the host's normal flow (see
   "Installing the result", pointing at your local checkout), and try the skill. Also run
   `npx skills add <path-to-repo> --list` and confirm it offers only the skills you mean to
   publish.

9. **Keep the host repo's formatter off the marketplace content.** If the repo runs Prettier (or
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
- **`skills` CLI:** `npx skills add <owner>/<repo>`. This channel does not read the generated
  registries. It scans the repo for `SKILL.md` files, including host folders like
  `.claude/skills/`, and skips any skill whose frontmatter has `metadata.internal: true`. That
  field only hides a skill from the listing; someone who names the skill explicitly can still
  install it, so it is not a way to keep content private.

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
- `unpublished-skill-installable` — a `SKILL.md` outside every published plugin lacks
  `metadata.internal: true`, so the `skills` CLI offers it to users. Decide who the skill is for
  (step 4): mark it internal, or move it into a published plugin.

`aipm lint` reports three related checks that `aipm validate` does not:

- `correctness/published-skill-internal` — a published skill is marked internal and so is hidden
  from `skills` CLI users. Remove the field, or move the skill out of the plugin.
- `correctness/plugin-self-containment` — a path or markdown link in a plugin points outside the
  plugin's folder and won't exist once installed. Move the file into the plugin.
- `correctness/unpublished-skill-reference` — published content mentions a contributor skill by
  name. If it relies on that skill, move what it needs into the plugin; a coincidental word match
  can be ignored.
