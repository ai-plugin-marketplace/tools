---
'@ai-plugin-marketplace/cli': minor
'@ai-plugin-marketplace/core': minor
---

Add `aipm lint [path] [--as <mode>] [--format text|json|sarif] [--rule <id>=<severity> ...]`, exposing the lint engine core (#61) via the CLI with machine-readable output.

- `text` (default): grouped by file as `file:line:col ruleId severity message`; `--verbose` appends the docs URL; diagnostics without a `range` render as `file ruleId severity message` (position segment omitted, never zero-filled).
- `json`: the raw `Diagnostic[]` plus a summary envelope (`errorCount`/`warnCount`/`infoCount`/`fileCount`).
- `sarif`: SARIF 2.1.0, one `rules[]` entry per distinct rule id — validated in tests against the official SARIF 2.1.0 JSON Schema.
- Exit codes: `0` no `error`-severity diagnostics, `1` errors present, `2` usage error (unknown `--format`, malformed `--rule`, or an unsupported `--as` mode — only `aipm-repo` is implemented; foreign discovery modes are a later issue).
- `--rule <id>=<severity>` (repeatable) overrides a rule's severity post-hoc, or drops its diagnostics entirely with `=off`.
- New core export: `applyRuleSeverityOverrides(diagnostics, overrides)`, the pure filter backing `--rule`.
- `aipm validate` behavior and exit codes are unchanged.
