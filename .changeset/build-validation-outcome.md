---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Add `buildWithOutcome(path, options?)` to return per-plugin build results and post-build validation findings together as `{ results, validation }`. Existing callers can keep using `build(path, options?)` for the results array. To consume diagnostics from the same build, switch to `buildWithOutcome()` and read `results` and `validation`. With `failFast` enabled, hard structural findings and filesystem errors that prevent validation reject the build. Otherwise, validation I/O failures appear as hard `BuildFreshnessIoFinding` diagnostics in the outcome.
