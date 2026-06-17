# @ai-plugin-marketplace/cli

## 0.3.1

### Patch Changes

- Updated dependencies [[`0bfc191`](https://github.com/ai-plugin-marketplace/tools/commit/0bfc191e54cb76d5ca223bfec6f5efbd223fcbd9), [`8c7bef1`](https://github.com/ai-plugin-marketplace/tools/commit/8c7bef1d65a3614924775c643550d384d342d7a7)]:
  - @ai-plugin-marketplace/core@0.5.0

## 0.3.0

### Minor Changes

- [#22](https://github.com/ai-plugin-marketplace/tools/pull/22) [`5795854`](https://github.com/ai-plugin-marketplace/tools/commit/57958544cd2684690bd680c2014fde27bca4f7e9) Thanks [@mike-north](https://github.com/mike-north)! - Guard against duplicate marketplace names that collide on install, and give `aipm init` a distinct
  marketplace name by default.

  Two marketplaces registered under the same `name` collide on install: the later one shadows and
  strands the earlier one's plugins. The template historically shipped `marketplace.name =
"ai-plugin-marketplace"` (the upstream's own name), so forks that never renamed it collided with
  upstream. These two changes make that failure mode hard to fall into.
  - **`aipm validate` warns on a default/placeholder marketplace name.** A new soft (warning-only)
    `default-marketplace-name` finding fires when the repo's effective marketplace `name` is a known
    placeholder (`ai-plugin-marketplace`, `my-ai-plugins`) or its `owner.name` is a placeholder
    (`AI Plugin Marketplace Template`, `Your Name`). The effective identity is read from
    `aipm.workspace.ts` when present, otherwise from a committed repo-root registry's top-level
    `name`/`owner.name`; when no marketplace metadata is declared, nothing is emitted. The finding is
    always soft — it never fails `aipm validate` — and includes a hint to rename to a unique value
    (convention `"<your-handle>-ai-plugins"`).
  - **`aipm init --name <name>` and a distinct default marketplace name.** `aipm init` now writes a
    named marketplace into both repo-root registries
    (`{ "name", "owner": { "name" }, "plugins": [] }`) instead of a nameless `{ "plugins": [] }`. The
    marketplace name defaults to `${USER}-ai-plugins` (falling back to the `my-ai-plugins` placeholder
    when `$USER` is unset, which `aipm validate` then flags as a nudge to set a real name) and can be
    overridden with `aipm init --name <name>`. A new `InitOptions.marketplaceName` carries the
    resolved name; the default is resolved at the I/O boundary so the file-templating layer stays a
    pure function of its inputs.

### Patch Changes

- Updated dependencies [[`bbaeaed`](https://github.com/ai-plugin-marketplace/tools/commit/bbaeaedf6c087c325b696863778216b648ef1ddf), [`5795854`](https://github.com/ai-plugin-marketplace/tools/commit/57958544cd2684690bd680c2014fde27bca4f7e9)]:
  - @ai-plugin-marketplace/core@0.4.0

## 0.2.0

### Minor Changes

- [#17](https://github.com/ai-plugin-marketplace/tools/pull/17) [`015c40c`](https://github.com/ai-plugin-marketplace/tools/commit/015c40c2a6ce928a4c3cc30cf26668056ce98a9d) Thanks [@mike-north](https://github.com/mike-north)! - Add `aipm init --refresh` to keep a marketplace repo's toolkit-owned scaffold files (the CI
  workflow and `.gitignore`) in sync with the installed tooling — the upgrade path to run after
  `pnpm up @ai-plugin-marketplace/*`. A `.aipm/scaffold.json` content-hash sidecar (seeded by
  `aipm init`) guards the operation: pristine files are upgraded, missing files recreated, and files
  the author has edited are reported as conflicts and left untouched unless `--force` is given. The
  new `refreshScaffold` operation is exported from `@ai-plugin-marketplace/core`. `aipm init` also now
  records `packageManager` in the generated `package.json` so the generated CI workflow resolves a
  pnpm version.

### Patch Changes

- Updated dependencies [[`015c40c`](https://github.com/ai-plugin-marketplace/tools/commit/015c40c2a6ce928a4c3cc30cf26668056ce98a9d), [`015c40c`](https://github.com/ai-plugin-marketplace/tools/commit/015c40c2a6ce928a4c3cc30cf26668056ce98a9d)]:
  - @ai-plugin-marketplace/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`defaef3`](https://github.com/ai-plugin-marketplace/tools/commit/defaef3ef4e311b8a90b3803cd2bdc944648ca68), [`4e66889`](https://github.com/ai-plugin-marketplace/tools/commit/4e66889c6b805db056c20dc5280c67f7622e4171), [`30d971d`](https://github.com/ai-plugin-marketplace/tools/commit/30d971d08fc00397b2e09b5578e83fb633d8de9c), [`4cb6cfe`](https://github.com/ai-plugin-marketplace/tools/commit/4cb6cfe4eaae09a34a544da3231949acc69d7617), [`27f715a`](https://github.com/ai-plugin-marketplace/tools/commit/27f715a0f2d8eb17ef6458349318deadde94f093), [`598ce73`](https://github.com/ai-plugin-marketplace/tools/commit/598ce737519974a8e77c0f52adc2ba75c89ec6bd), [`e8fac5a`](https://github.com/ai-plugin-marketplace/tools/commit/e8fac5a1967bf7d94bc1255a1c387f8afb80670e)]:
  - @ai-plugin-marketplace/core@0.2.0

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

### Patch Changes

- Updated dependencies [[`a795137`](https://github.com/ai-plugin-marketplace/tools/commit/a795137db933445fd37d7dd05e97723ded6d10aa)]:
  - @ai-plugin-marketplace/core@0.1.0
