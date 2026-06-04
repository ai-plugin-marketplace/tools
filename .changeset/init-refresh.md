---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Add `aipm init --refresh` to keep a marketplace repo's toolkit-owned scaffold files (the CI
workflow and `.gitignore`) in sync with the installed tooling — the upgrade path to run after
`pnpm up @ai-plugin-marketplace/*`. A `.aipm/scaffold.json` content-hash sidecar (seeded by
`aipm init`) guards the operation: pristine files are upgraded, missing files recreated, and files
the author has edited are reported as conflicts and left untouched unless `--force` is given. The
new `refreshScaffold` operation is exported from `@ai-plugin-marketplace/core`. `aipm init` also now
records `packageManager` in the generated `package.json` so the generated CI workflow resolves a
pnpm version.
