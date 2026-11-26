# Releasing `@ai-plugin-marketplace/*`

[Changesets](https://github.com/changesets/changesets) versions
`@ai-plugin-marketplace/core` and `@ai-plugin-marketplace/cli` independently. The CLI depends on
core via `workspace:^`, which pnpm rewrites to a caret range based on core's workspace version
when packaging the CLI.

## Publishing

The [Release workflow](.github/workflows/release.yml) publishes to npm using OIDC trusted
publishing. Configure the npm trusted publisher for each package to use the
`ai-plugin-marketplace/tools` repository, the `release.yml` workflow, and the `npm-publish` GitHub
environment. The workflow requests `id-token: write` to authenticate with npm.

1. Run `pnpm changeset` to record the bump for each affected package. Commit the changeset with the
   change.
2. On push to `main`, the Changesets action opens or updates the **Version Packages** pull request
   with the version and changelog updates.
3. Merge the Version Packages pull request. The next run builds and publishes the unpublished
   package versions. Maintainers can also run the workflow manually from the **Release** workflow
   page in GitHub Actions.

A **minor or patch** toolkit release never requires downstream plugin authors to change their
manifests (architecture spec §9.3). Major releases may require `aipm migrate` (a no-op today).

## How downstream consumes this

A plugin repo (see `aipm init`, or the
[`template`](https://github.com/ai-plugin-marketplace/template)) depends on
`@ai-plugin-marketplace/cli` + `@ai-plugin-marketplace/core` via `^semver` and runs everything
through the `aipm` binary. Update both packages within their existing ranges with:

```sh
pnpm up @ai-plugin-marketplace/cli @ai-plugin-marketplace/core
aipm build
```

To cross a caret boundary, including a pre-1.0 minor line, select versions for both packages.
Choose a core version within the selected CLI release's core dependency range. For example, CLI
`0.8.1` depends on core `^0.12.0`, outside a consumer's existing `^0.11.0` range:

```sh
pnpm add -D @ai-plugin-marketplace/cli@0.8.1 @ai-plugin-marketplace/core@0.12.0
aipm build
```
