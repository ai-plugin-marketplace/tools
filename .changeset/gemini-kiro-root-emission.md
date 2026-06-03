---
'@ai-plugin-marketplace/core': minor
---

Add opt-in Gemini/Kiro repo-root native emission for single-artifact hosts.

Gemini CLI and Kiro have no multi-plugin marketplace concept — each installs exactly one
extension/power per repo, read from the repository root (`gemini extensions install <git>` reads a
root `gemini-extension.json`; Kiro "Add from GitHub" reads a root `POWER.md`). When an
`aipm.workspace.ts` is present at the repo root, `aipm build` now emits a single Gemini extension
and/or a single Kiro power at the repo root, committed and freshness-checked. When the workspace
config is absent, behavior is unchanged.

Two new `FindingCode` values are added:

- `single-artifact-host` (hard): more than one plugin declares the same single-artifact host
  (`gemini` or `kiro`). The toolkit cannot choose which plugin owns the single repo-root slot, so it
  suppresses emission for that host and reports the ambiguity. The two hosts are independent — a repo
  where one plugin declares `gemini` and another declares `kiro` emits both.
- `root-artifact-collision` (hard): a generated repo-root path is already occupied by a file the
  toolkit does not track as previously-generated (it belongs to the host software or the author).
  Generation refuses to overwrite it.

Generation is safe by construction: bundles are produced into a throwaway temp directory (the
bundlers' destination-clearing contract is never pointed at the repo root), the exact set of
generated repo-root paths is recorded in a committed sidecar manifest (`.aipm/generated-root.json`),
and orphan removal is bounded strictly to that previously-tracked set — the toolkit never deletes a
file it did not record as generated. Validation regenerates the expected root artifacts through the
same code path the build uses and byte-compares them, so the build output and the freshness oracle
cannot drift.
