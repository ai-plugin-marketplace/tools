---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Add `buildWithOutcome(path, options?)` to return per-plugin build results and post-build validation findings together as `{ results, validation }`. Existing callers can keep using `build(path, options?)` for the results array. To consume diagnostics from the same build, switch to `buildWithOutcome()` and read `results` and `validation`. With `failFast` enabled, hard structural findings still reject the build. Freshness I/O failures are returned as hard `BuildFreshnessIoFinding` diagnostics in the outcome.
