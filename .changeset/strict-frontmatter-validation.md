---
'@ai-plugin-marketplace/core': minor
---

Validate that plugin frontmatter parses as strict YAML. `runValidate` now strict-parses the YAML frontmatter of every `skills/<name>/SKILL.md`, `agents/*.md`, `commands/*.md`, and `POWER.md`, emitting a hard `frontmatter-invalid` finding when it fails. This catches frontmatter that loads on a lenient host (Claude Code) but is rejected by a strict one (e.g. Codex's skill loader) — the classic case being an unquoted `": "` (colon-space) inside a `description` value, which YAML reads as an illegal nested mapping. Adds the `frontmatter-invalid` value to the `FindingCode` union.
