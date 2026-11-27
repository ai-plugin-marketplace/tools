---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Scaffold with verified CLI release metadata while preserving programmatic `init(dir)` and
`init(dir, { name })` calls. The default CLI release comes from the toolkit build. The CLI
dependency range must include the bundled release. Programmatic `init` accepts compatible
`cliVersion` shorthand and SemVer build identifiers. It normalizes loose forms such as `0.08.0`
and rejects specifiers that could resolve to files or URLs. `aipm init` uses its own installed
manifest. Before publishing, the release workflow verifies the packaged CLI identity and core
entry points and rejects package versions npm would rewrite.
