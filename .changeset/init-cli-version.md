---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Scaffold with verified CLI release metadata while preserving programmatic `init(dir)` and
`init(dir, { name })` calls. The default CLI release comes from the toolkit build. The CLI
dependency range must include the bundled release. Compatible `cliVersion` shorthand,
such as `0.8`, is accepted. `aipm init` uses its own installed manifest.
The release workflow verifies the packaged CLI identity and core entry points before publishing.
Programmatic `init` rejects build metadata and specifiers that could resolve to files or URLs.
