# @ai-plugin-marketplace/core

## 0.1.0

### Minor Changes

- [`a795137`](https://github.com/ai-plugin-marketplace/tools/commit/a795137db933445fd37d7dd05e97723ded6d10aa) Thanks [@mike-north](https://github.com/mike-north)! - Bootstrap release of the `@ai-plugin-marketplace` toolkit (v0.1.0).

  **`@ai-plugin-marketplace/core`**
  - `defineConfig` / `AipmConfig` — typed, Zod-validated plugin config with branded output and `.strict()` parsing.
  - Support envelope validation — plugins declare supported targets; the validator enforces adherence.
  - Per-target Zod schemas for Claude Code, Cursor, Gemini CLI, Kiro, and Vercel Skills CLI.
  - Build pipeline with a named `transform` step — mechanical transformations (YAML→JSON, tool-name mapping, bundle assembly) live inside each target's step and never cross target boundaries.
  - `validate` — envelope, schema, adherence, cross-target consistency, and freshness checks.
  - `build` — generates per-target artifacts and standalone bundles with generated-file sentinels.
  - `scaffold` / `addTarget` — scaffolds new plugins and adds targets to existing ones.
  - `init` — generates a light, toolkit-consuming plugin repo (the basis for the template).
  - `checkSupport` / `listTargets` — compatibility-assist diagnostics.
  - `migrate` — no-op in this release; groundwork for future migrex schema migrations.

  **`@ai-plugin-marketplace/cli`**
  - `aipm` binary wrapping all `core` capabilities: `init`, `build`, `validate`, `scaffold`,
    `add-target`, `check-support`, `list-targets`, `migrate`.
