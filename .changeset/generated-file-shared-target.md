---
'@ai-plugin-marketplace/core': major
---

`GeneratedFile.target` now accepts `'shared'` in addition to a `TargetId` (the new
`GeneratedFileTarget = TargetId | 'shared'` type). Two build artifacts genuinely have no single
owning target — `hooks/payload-adapter` (and its sidecar), emitted for any plugin authoring hooks
regardless of which targets it declares, and the generated-root sidecar manifest
(`.aipm/generated-root.json`), which spans every emitted single-artifact-host/registry owner — and
were previously attributed to an arbitrary, deterministically-chosen single target as a workaround.
Both now report `target: 'shared'` instead.

Consumers reading `BuildResult.artifacts[].target` and narrowing on `TargetId` should account for
the new `'shared'` value; a `switch` over `TargetId` alone will no longer be exhaustive against
`GeneratedFileTarget`.
