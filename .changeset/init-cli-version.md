---
'@ai-plugin-marketplace/core': minor
---

Scaffold with verified CLI release metadata while preserving programmatic `init(dir)` and
`init(dir, { name })` calls. The default CLI release comes from the toolkit build. To select
another installed CLI release, pass its `package.json` file URL as `cliPackageJson`. A
`cliVersion` override must produce a caret range that includes the selected release.
`aipm init` uses its own installed manifest.
