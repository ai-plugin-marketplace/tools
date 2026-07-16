---
'@ai-plugin-marketplace/core': minor
---

Add the position-aware lint engine core (`Diagnostic`/`Rule`/document-layer types, `lint()`) and migrate every existing `validate()` check onto it, with `aipm validate` behavior unchanged.

- New `packages/core/src/lint/` module: `Diagnostic`, `Range`, `Rule`, `RuleContext` types (L-D1/L-D4), a position-aware document layer for JSON (`jsonc-parser`), YAML (the `yaml` package's CST), and markdown frontmatter, and a pure `diagnosticToFinding()` mapping back to the legacy `Finding` shape.
- Every existing validate check (envelope shape, per-target schema, envelope adherence, frontmatter parsing, name consistency, MCP key sync, marketplace registration, freshness, default-marketplace-name) is now backed by a `Rule` object carrying its legacy `FindingCode`.
- Four new `correctness/*` rules: `broken-file-ref`, `unknown-hook-event`, `invalid-matcher`, `duplicate-component-name`.
- New public exports: `lint(path, options): Promise<LintResult>`, plus `Diagnostic`, `Range`, `Rule`, `RuleContext`, `Document`/`JsonDocument`/`YamlDocument`/`FrontmatterDocument`, `Fix`, `Position`, `LintOptions`, `LintResult`, and `ConfigCache`.
- `jsonc-parser` is now a direct dependency (previously transitive only).
