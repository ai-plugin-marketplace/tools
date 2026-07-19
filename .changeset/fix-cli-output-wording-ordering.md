---
'@ai-plugin-marketplace/core': patch
'@ai-plugin-marketplace/cli': patch
---

Fix three CLI output-wording/ordering defects that misled users during a normal build/validate
run (no behavior change — the same conditions are still detected, only how/when they are
reported changes):

- Pre-build freshness on a dist bundle file that was never built now reports `missing` with a
  "run `aipm build`" hint, instead of `stale`.
- `aipm build`'s `Built N plugin(s), M artifact(s).` success line no longer prints when the
  post-build `validate` step has a hard finding that fails the run.
- The `version-consistency` finding now hints that `aipm.config.ts` is the source of truth for
  the version, so the manifest — not the config — is the one to bump.
