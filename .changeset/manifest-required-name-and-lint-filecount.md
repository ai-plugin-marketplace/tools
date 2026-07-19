---
'@ai-plugin-marketplace/core': patch
'@ai-plugin-marketplace/cli': patch
---

Fix `aipm validate` and `aipm lint` silently accepting a Claude `plugin.json` that is valid JSON but omits a schema-required field (e.g. `name`) — this now emits a hard `schema-invalid` finding / `schema/target-conformance` diagnostic, matching the other targets' behavior. `aipm lint --format json`'s `summary.fileCount` now reflects the files a run actually scanned (`LintResult.scannedFiles`) instead of the number of distinct files a diagnostic happened to be attached to, which previously stayed pinned regardless of manifest changes.
