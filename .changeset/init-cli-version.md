---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Scaffold with verified CLI release metadata while preserving programmatic `init(dir)` and
`init(dir, { name })` calls. The default CLI release comes from the toolkit build. The CLI
dependency range must include the bundled release. Compatible `cliVersion` shorthand,
such as `0.8`, is accepted. `aipm init` uses its own installed manifest.
Core packaging checks the bundled metadata against the CLI manifest.
