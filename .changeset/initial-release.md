---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Bootstrap release of the `@ai-plugin-marketplace` toolkit (v0.1.0).

**`@ai-plugin-marketplace/core`**

- `defineConfig` / `AipmConfig` — typed, Zod-validated plugin config with branded output and `.strict()` parsing.
- Support envelope validation — plugins declare supported targets; the validator enforces adherence.
- Per-target Zod schemas for Claude Code, Cursor, Gemini CLI, Kiro, and Vercel Skills CLI.
- Build pipeline with a named `transform` step — mechanical transformations (YAML→JSON, tool-name mapping, bundle assembly) live inside each target's step and never cross target boundaries.
- `aipm validate` — envelope, schema, adherence, cross-target consistency, and freshness checks.
- `aipm scaffold` / `aipm add-target` — scaffolds new plugins and adds targets to existing ones.

**`@ai-plugin-marketplace/cli`**

- `aipm` binary wrapping all `core` capabilities.
- `aipm build`, `aipm validate`, `aipm scaffold`, `aipm add-target`, `aipm check-support`.
- Schema-migration stub (`aipm migrate` — no-op in this release; groundwork for future migrex adoption).
