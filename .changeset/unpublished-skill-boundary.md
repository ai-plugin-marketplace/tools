---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Catch contributor-only skills that leak to users through install channels that scan the
repository instead of reading a registry (such as `npx skills add`).

`aipm validate` now fails with a new hard finding, `unpublished-skill-installable`, when a
`SKILL.md` is neither inside a published plugin nor toolkit-generated and its frontmatter lacks
`metadata.internal: true`. The finding names the file and the choice to make: mark the skill
internal if it is for contributors, or move it into a published plugin if it is for users. The
toolkit never edits the file. **A repo that keeps unmarked skills outside its plugins root (for
example under `.claude/skills/`) will start failing `aipm validate` until each one is marked or
moved.** `aipm build` is unaffected and does not fail on this finding. Skills recorded in the
repo's `skills-lock.json` (installed with the `skills` CLI) and symlinks to published skills are
exempt.

`aipm lint` reports the same check as `correctness/unpublished-skill-installable`, plus three new
lint-only rules:

- `correctness/published-skill-internal` (warn): a published skill is marked internal and so is
  hidden from `skills` CLI users.
- `correctness/plugin-self-containment` (error): a manifest path or markdown link in a plugin
  resolves outside the plugin's directory, so it will be missing once the plugin is installed.
- `correctness/unpublished-skill-reference` (warn): published content mentions an unpublished
  skill by name.

`FindingCode` gains the `unpublished-skill-installable` member, and `ValidateOptions` gains
`skipPublishedSurfaceBoundary`, which `build` uses for its post-build validation.
