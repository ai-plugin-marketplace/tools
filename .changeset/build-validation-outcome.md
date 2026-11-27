---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Add `buildWithOutcome(path, options?)` to return per-plugin build results and post-build validation findings together as `{ results, validation }`. Existing callers can keep using `build(path, options?)` for the results array. To consume diagnostics from the same build, switch to `buildWithOutcome()` and read `results` and `validation`. With `failFast` enabled, the same post-build checks reject as for `build()`. Standalone-validation findings stay in the outcome. Filesystem failures observed on selected inputs, including config module reads, appear as hard `BuildFreshnessIoFinding` diagnostics.
