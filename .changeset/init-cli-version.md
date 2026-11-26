---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Scaffold with verified CLI release metadata while preserving programmatic `init(dir)` and
`init(dir, { name })` calls. The default CLI release comes from the toolkit build. To select
an installed CLI release as the default caret base, pass its manifest URL as `cliPackageJson`.
The CLI dependency range must include the bundled release and any release supplied through
`cliPackageJson`, even with a `cliVersion` override. `aipm init` uses its own installed manifest.
Core packaging checks the bundled metadata against the CLI manifest.
