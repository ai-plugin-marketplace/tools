---
'@ai-plugin-marketplace/core': minor
---

Require an explicit `cliVersion` in programmatic `init()` calls so the scaffold pins the intended CLI release. Pass the CLI package version you intend to install as `init(dir, { cliVersion })`. The `aipm init` command supplies its own version automatically.
