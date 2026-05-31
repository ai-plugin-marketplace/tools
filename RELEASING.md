# Releasing `@ai-plugin-marketplace/*`

Versioning and publishing are driven by [Changesets](https://github.com/changesets/changesets).
`@ai-plugin-marketplace/core` and `@ai-plugin-marketplace/cli` are versioned in lockstep; the cli
pins core to the matching version, so downstream consumers always get a consistent pair.

## Publishing (the only step that needs credentials)

Everything is in place for the first release (`0.1.0`). The **only** missing piece is an npm
credential:

1. Create an **npm automation token** with publish rights to the `@ai-plugin-marketplace` scope
   (npmjs.com → Access Tokens → Generate → _Automation_).
2. Add it as the repository secret **`NPM_TOKEN`** (GitHub → Settings → Secrets and variables →
   Actions → New repository secret).

Then publish via either path:

- **CI (recommended).** On push to `main`, the [Release workflow](.github/workflows/release.yml)
  uses the Changesets action. When changesets are pending it opens a **"Version Packages"** PR
  (bumping to `0.1.0` and writing `CHANGELOG.md`s); **merge that PR** and the next run publishes to
  npm. You can also trigger the workflow manually (Actions → Release → _Run workflow_).
- **Local.** With npm auth available and a `GITHUB_TOKEN` exported (the changelog generator needs
  it to resolve PR/commit links):

  ```sh
  GITHUB_TOKEN=$(gh auth token) pnpm changeset version   # bumps to 0.1.0, writes changelogs
  pnpm install                                            # refresh the lockfile
  pnpm changeset publish                                  # publishes to npm
  ```

The publish rewrites the cli's `workspace:^` dependency on core to `^0.1.0` automatically.

## Cutting subsequent releases

1. Make changes; run `pnpm changeset` to record a `patch`/`minor`/`major` bump per package.
2. Commit the changeset and push. CI opens/refreshes the Version PR.
3. Merge the Version PR → CI publishes.

A **minor or patch** toolkit release never requires downstream plugin authors to change their
manifests (architecture spec §9.3). Major releases may require `aipm migrate` (a no-op today).

## How downstream consumes this

A plugin repo (see `aipm init`, or the
[`template`](https://github.com/ai-plugin-marketplace/template)) depends on
`@ai-plugin-marketplace/cli` + `@ai-plugin-marketplace/core` via `^semver` and runs everything
through the `aipm` binary. Authors upgrade the whole toolkit with:

```sh
pnpm up @ai-plugin-marketplace/cli @ai-plugin-marketplace/core
aipm build
```

This is the point of the toolkit: validation rules, build pipelines, and schemas are centrally
versioned here and consumed downstream — authors are never stranded on a forked copy.
