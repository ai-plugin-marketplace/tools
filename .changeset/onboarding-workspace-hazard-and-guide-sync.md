---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Warn `aipm init` about an ancestor pnpm workspace instead of leaving newcomers to silently
corrupt it, and sync the CLI's `README.md`/docs quick start with `aipm --help`.

A directory with no local `package.json` that sits under an ancestor `pnpm-workspace.yaml` has
`pnpm add`/`pnpm install` silently target the ANCESTOR's manifest and lockfile instead of a new
repo's own — a first-time user following the old quick start verbatim could corrupt an unrelated
parent project with no warning.

- `init()`'s public return type changes from `Promise<void>` to `Promise<InitOutcome>` (new
  exported type: `{ ancestorWorkspace?: string }`). `ancestorWorkspace` is the absolute path to an
  ancestor `pnpm-workspace.yaml`, when one exists above the newly scaffolded directory.
- `aipm init` prints a warning to stderr when `ancestorWorkspace` is set, before telling the user
  to run `pnpm install`.
- `packages/cli/README.md` ("GUIDE.md" in the published package) now: requires `npm init -y`
  before the install command, with an explicit workspace-hazard note; documents the `lint`
  command and every subcommand's flags (previously undocumented, though implemented); includes
  the quick start's install step; and replaces the dead `../../docs/specs/architecture.md`
  relative link (only resolvable inside the monorepo checkout, not the published npm package)
  with an absolute GitHub URL.
