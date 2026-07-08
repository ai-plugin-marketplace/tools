---
'@ai-plugin-marketplace/core': minor
---

Add soft Open Plugins conformance advisories on the native `claude`/`cursor`/`codex` targets.

`aipm validate` now surfaces a new **soft** `open-plugins-conformance` finding (added to the
`FindingCode` union) that nudges native plugins toward Open Plugins portability without ever failing
them — it never flips `ValidationResult.passed`. Two advisories fire today:

- **Name-grammar drift** — a plugin `name` that is valid for the native target but violates the Open
  Plugins name grammar (e.g. `a--b` or a trailing hyphen, which the native scaffold-slug regex
  accepts but Open Plugins rejects). It fires only for otherwise-native-valid manifests, so a broken
  name still gets its usual hard finding without a duplicate advisory.
- **Metadata-dir isolation** — a non-`plugin.json` entry in a plugin's vendor metadata directory
  (`.claude-plugin/` / `.cursor-plugin/` / `.codex-plugin/`), which Open Plugins requires to hold
  only `plugin.json`.

Also hardens path-traversal rejection: a `..` segment in the `mcpServers` (and Codex `apps`/`hooks`)
config-path fields — previously unchecked because those paths are not existence-validated — is now a
hard `schema-invalid` across all three targets, matching the existing rejection on component paths.

The Open Plugins `name` grammar is now a single shared source of truth
(`targets/open-plugins-conformance.ts`) consumed by both the `open-plugins` target schema (where a
violation is hard) and these advisories (where it is soft).
