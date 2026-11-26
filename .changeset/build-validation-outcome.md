---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': patch
---

Return per-plugin build results and post-build validation findings together as `{ results, validation }`. Update callers that previously consumed the array directly to read `outcome.results`. The CLI reports findings from the build's single validation pass. The `failFast` option rejects after generation and validation complete when there are hard findings.
