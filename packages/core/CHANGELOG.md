# @ai-plugin-marketplace/core

## 0.4.0

### Minor Changes

- [#20](https://github.com/ai-plugin-marketplace/tools/pull/20) [`bbaeaed`](https://github.com/ai-plugin-marketplace/tools/commit/bbaeaedf6c087c325b696863778216b648ef1ddf) Thanks [@mike-north](https://github.com/mike-north)! - `aipm init` now seeds a comprehensive `.gitignore` and stops refresh-managing it.
  - **Safety fix:** a fresh `aipm init` previously wrote only a 4-line `.gitignore`, so a brand-new
    scaffold could easily commit secrets. The seeded `.gitignore` now ignores `.env*`, `*.log`,
    `coverage`, common caches, and `scratch/` (while retaining `node_modules/`, `*.tsbuildinfo`,
    `*.local.*`, and `.DS_Store`). Build output (`dist/`) is deliberately still tracked.
  - **No more perpetual refresh conflict:** `.gitignore` is now **seed-only** — written by `init` and
    owned by the user thereafter. It has been removed from the `aipm init --refresh` managed set
    (`.aipm/scaffold.json` now tracks only `.github/workflows/ci.yml`), so user additions to
    `.gitignore` are never clobbered or perpetually flagged as conflicts.

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

## 0.3.0

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

- [#17](https://github.com/ai-plugin-marketplace/tools/pull/17) [`015c40c`](https://github.com/ai-plugin-marketplace/tools/commit/015c40c2a6ce928a4c3cc30cf26668056ce98a9d) Thanks [@mike-north](https://github.com/mike-north)! - Fix `aipm init` pinning a nonexistent `@ai-plugin-marketplace/cli` version. `init` pinned both the
  `cli` and `core` dev dependencies to core's own version; because `cli` and `core` ship
  independently (e.g. `cli 0.1.1` ships with `core 0.2.0`), this produced a `package.json` requesting
  a `cli` version that does not exist on npm, yielding an uninstallable repo. `init` now pins each
  dependency to a caret of its own version (the cli entrypoint supplies the cli version).

## 0.2.0

### Minor Changes

- [#5](https://github.com/ai-plugin-marketplace/tools/pull/5) [`defaef3`](https://github.com/ai-plugin-marketplace/tools/commit/defaef3ef4e311b8a90b3803cd2bdc944648ca68) Thanks [@mike-north](https://github.com/mike-north)! - Add `codex` (OpenAI Codex CLI) as a supported target: `.codex-plugin/plugin.json` manifest, shared skills/MCP, and a `.agents/plugins/marketplace.json` repo-marketplace registry. Codex is an in-place marketplace target like Claude and Cursor.

- [#3](https://github.com/ai-plugin-marketplace/tools/pull/3) [`4e66889`](https://github.com/ai-plugin-marketplace/tools/commit/4e66889c6b805db056c20dc5280c67f7622e4171) Thanks [@mike-north](https://github.com/mike-north)! - Add optional repo-level configuration (`aipm.repo.ts` / `defineRepoConfig`) for relocating the plugins and dist roots.

  This lets a marketplace live inside a repo whose primary purpose is shipping software: when the host repo already owns a top-level `plugins/` or `dist/`, declare a `pluginsRoot` / `distDir` in `aipm.repo.ts` and the toolkit discovers, builds, validates, and scaffolds against the relocated roots. The file is optional and fully backward compatible — absent it, the historical `plugins/` + `dist/` topology is used unchanged.
  - New public exports: `defineRepoConfig`, `AipmRepoConfig`, `AipmRepoConfigInput`.
  - Marketplace `source` registration now expects the plugin's path relative to the repo root, so a relocated `pluginsRoot` validates correctly.
  - A present-but-invalid `aipm.repo.ts` (unknown keys, absolute paths, `..` escapes) surfaces as a new `repo-config-invalid` validation finding rather than an unstructured error.

- [#14](https://github.com/ai-plugin-marketplace/tools/pull/14) [`30d971d`](https://github.com/ai-plugin-marketplace/tools/commit/30d971d08fc00397b2e09b5578e83fb633d8de9c) Thanks [@mike-north](https://github.com/mike-north)! - Add opt-in Gemini/Kiro repo-root native emission for single-artifact hosts.

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

- [#11](https://github.com/ai-plugin-marketplace/tools/pull/11) [`27f715a`](https://github.com/ai-plugin-marketplace/tools/commit/27f715a0f2d8eb17ef6458349318deadde94f093) Thanks [@mike-north](https://github.com/mike-north)! - Add opt-in marketplace-registry generation via `aipm.workspace.ts` (`defineWorkspace`), plus optional shared plugin metadata on `aipm.config.ts`.

  When a repo declares an `aipm.workspace.ts` at its root, the toolkit now GENERATES the per-target marketplace registries (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) from the workspace metadata plus the discovered plugins. The generated registries are written by `aipm build`, committed, and freshness-checked (regenerate-and-byte-compare, like `dist/` bundles). This removes the manual chore of hand-editing the registries.
  - New public exports: `defineWorkspace`, `AipmWorkspace`, `AipmWorkspaceInput`.
  - New optional fields on `aipm.config.ts` (`defineConfig`): `description` and `keywords`. They feed each generated registry entry's `description` and `tags` (Claude/Cursor). Both are optional, so existing configs stay valid.
  - The opt-in is fully backward compatible: when no `aipm.workspace.ts` is present, registries remain hand-authored and the existing `marketplace-registration` validation runs unchanged.

  Consumer-visible finding-code shift: in repos that opt into generation, registry correctness is now enforced by the `freshness` finding code (a wrong or stale entry is regenerated-and-compared) and the per-plugin `marketplace-registration` check is skipped to avoid double-reporting. Repos without `aipm.workspace.ts` continue to emit `marketplace-registration` as before.

### Patch Changes

- [#15](https://github.com/ai-plugin-marketplace/tools/pull/15) [`4cb6cfe`](https://github.com/ai-plugin-marketplace/tools/commit/4cb6cfe4eaae09a34a544da3231949acc69d7617) Thanks [@mike-north](https://github.com/mike-north)! - Stop transpiling the whole package on every config load.

  When jiti loads an `aipm.config.ts` / `aipm.repo.ts` / `aipm.workspace.ts`, the loader aliased the `@ai-plugin-marketplace/core` import to the package **index**, which re-exports the entire source graph (`operations` → `build`/`validate` → all six targets + `yaml`). So every config load re-transpiled the whole package — hundreds of times across a run — which on slow CI blocked the test worker long enough to trip vitest's `onTaskUpdate` RPC timeout intermittently (a flake that never reproduced locally because production loads the precompiled `dist/`, not source).

  The loader now aliases the specifier to the minimal **`config`** module (the `define*` functions; deps are just `zod` + `types`), and enables jiti's content-keyed on-disk transpile cache (`fsCache: true`) while keeping the in-memory module cache off (so in-process rewrites are still re-evaluated — covered by a new regression test). Together these cut the build/validate suite's test time by roughly an order of magnitude (~35s → ~3s locally). Also reverts an earlier single-fork CI workaround that addressed the wrong layer.

- [#16](https://github.com/ai-plugin-marketplace/tools/pull/16) [`598ce73`](https://github.com/ai-plugin-marketplace/tools/commit/598ce737519974a8e77c0f52adc2ba75c89ec6bd) Thanks [@mike-north](https://github.com/mike-north)! - Fix a false `freshness` finding on the generated-root sidecar manifest.

  When a single plugin declares both `gemini` and `kiro`, a file shared by both bundles (e.g. `skills/<name>/SKILL.md`) is emitted to the repo root once, but the validate-side freshness oracle collects it once per emitting host. `serializeRootManifest` sorted but did not dedupe, so the manifest build wrote (from a deduped set) never matched the oracle's (duplicated) expectation — the sidecar read as perpetually stale right after a successful build. `serializeRootManifest` now dedupes as well as sorts, so the bytes are canonical regardless of caller. Surfaced by dogfooding the toolchain on its own repo.

- [#9](https://github.com/ai-plugin-marketplace/tools/pull/9) [`e8fac5a`](https://github.com/ai-plugin-marketplace/tools/commit/e8fac5a1967bf7d94bc1255a1c387f8afb80670e) Thanks [@mike-north](https://github.com/mike-north)! - Fix `aipm scaffold` and `aipm add-target` to register a repo-relative marketplace `source` that matches a relocated `pluginsRoot`.

  Previously the scaffolder hardcoded the registry `source` to `./plugins/<name>`. In an embedded marketplace (an `aipm.repo.ts` relocating `pluginsRoot`, e.g. to `agent-plugins/`), the plugin was written to the relocated root but registered as `./plugins/<name>`, which `aipm validate` then rejected with a `marketplace-registration` finding. The source is now computed as the plugin directory's path relative to the repo root (`./agent-plugins/<name>`), matching the validator, so the scaffold→validate flow is clean in both dedicated and embedded layouts.

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
