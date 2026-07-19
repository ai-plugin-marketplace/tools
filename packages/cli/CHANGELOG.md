# @ai-plugin-marketplace/cli

## 0.6.0

### Minor Changes

- [#81](https://github.com/ai-plugin-marketplace/tools/pull/81) [`cb16c38`](https://github.com/ai-plugin-marketplace/tools/commit/cb16c385a403afce900560e072ec4f8c4bbad244) Thanks [@mike-north](https://github.com/mike-north)! - Guard `aipm build` against a stale installed toolkit silently reverting generated artifacts.

  Every sentinel-carrying generated artifact is now stamped with the `@ai-plugin-marketplace/core`
  version that produced it (`_generated.version` in JSON outputs, a `# version:` line in
  inline/sidecar outputs). Before writing anything, `aipm build` compares the installed core version
  against the version stamped into existing committed artifacts: if the installed toolkit is **older**
  (by semver precedence), the build refuses with a non-zero exit and a message naming both versions
  and suggesting `pnpm install`. This closes the failure mode where a checkout with a stale
  `node_modules` regenerates committed outputs with an older generator and silently reverts a shipped
  fix. Equal-or-newer installs, first-time/unstamped trees, and same-version rebuilds proceed as
  before and (re)stamp with the installed version.
  - New `BuildOptions.forceDowngrade` and the `aipm build --force-downgrade` flag override the guard.
  - The freshness check ignores the version stamp, so a version bump alone no longer marks committed
    artifacts stale.

- [#84](https://github.com/ai-plugin-marketplace/tools/pull/84) [`6d2ee20`](https://github.com/ai-plugin-marketplace/tools/commit/6d2ee2028a7fcd77a7513106656a1d9f3853c925) Thanks [@mike-north](https://github.com/mike-north)! - `aipm validate` (and `lint()`'s `correctness/version-consistency` rule) now fails when a declared
  target's manifest `version` field (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  `.cursor-plugin/plugin.json`, `gemini-extension.json`, `POWER.md` frontmatter,
  `.plugin/plugin.json`) does not match `aipm.config.ts`'s `version`. Installs are keyed by manifest
  version, so a stale author-maintained manifest previously let a release ship with `aipm.config.ts`
  bumped but the manifest still pointing at the old version — auto-update silently kept serving the
  pre-release artifact. Mirrors the existing `name-consistency` check: a new `version-consistency`
  `FindingCode`, hard severity, one finding per mismatched manifest.

  Fixes a related scaffold bug this check surfaced: `aipm scaffold` wrote `aipm.config.ts` with
  `version: '0.1.0'` while every per-target scaffolded manifest wrote `version: '0.0.1'`, so a
  freshly-scaffolded plugin failed `version-consistency` immediately. `aipm scaffold` now emits
  `'0.0.1'` consistently everywhere.

### Patch Changes

- Updated dependencies [[`d0ac824`](https://github.com/ai-plugin-marketplace/tools/commit/d0ac824e2cfb2010bcd903901ccbb08a155527d6), [`cb16c38`](https://github.com/ai-plugin-marketplace/tools/commit/cb16c385a403afce900560e072ec4f8c4bbad244), [`f061725`](https://github.com/ai-plugin-marketplace/tools/commit/f0617256ba7abd918a12c67511b9f1644abe69fc), [`6d2ee20`](https://github.com/ai-plugin-marketplace/tools/commit/6d2ee2028a7fcd77a7513106656a1d9f3853c925)]:
  - @ai-plugin-marketplace/core@0.9.0

## 0.5.0

### Minor Changes

- [#72](https://github.com/ai-plugin-marketplace/tools/pull/72) [`6100387`](https://github.com/ai-plugin-marketplace/tools/commit/6100387eefbce1604220a9832ed44c2fb7533883) Thanks [@mike-north](https://github.com/mike-north)! - Add `aipm lint [path] [--as <mode>] [--format text|json|sarif] [--rule <id>=<severity> ...]`, exposing the lint engine core ([#61](https://github.com/ai-plugin-marketplace/tools/issues/61)) via the CLI with machine-readable output.
  - `text` (default): grouped by file as `file:line:col ruleId severity message`; `--verbose` appends the docs URL; diagnostics without a `range` render as `file ruleId severity message` (position segment omitted, never zero-filled).
  - `json`: the raw `Diagnostic[]` plus a summary envelope (`errorCount`/`warnCount`/`infoCount`/`fileCount`).
  - `sarif`: SARIF 2.1.0, one `rules[]` entry per distinct rule id — validated in tests against the official SARIF 2.1.0 JSON Schema.
  - Exit codes: `0` no `error`-severity diagnostics, `1` errors present, `2` usage error (unknown `--format`, malformed `--rule`, or an unsupported `--as` mode — only `aipm-repo` is implemented; foreign discovery modes are a later issue).
  - `--rule <id>=<severity>` (repeatable) overrides a rule's severity post-hoc, or drops its diagnostics entirely with `=off`.
  - New core export: `applyRuleSeverityOverrides(diagnostics, overrides)`, the pure filter backing `--rule`.
  - `aipm validate` behavior and exit codes are unchanged.

### Patch Changes

- Updated dependencies [[`d1e1af3`](https://github.com/ai-plugin-marketplace/tools/commit/d1e1af3f0527c66de15839204395b8024b5a86b1), [`6100387`](https://github.com/ai-plugin-marketplace/tools/commit/6100387eefbce1604220a9832ed44c2fb7533883), [`2b34d54`](https://github.com/ai-plugin-marketplace/tools/commit/2b34d547c3a0ff459198a87eb22e446a5c5d5b52)]:
  - @ai-plugin-marketplace/core@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`8251430`](https://github.com/ai-plugin-marketplace/tools/commit/825143089227710e6174ac8a71804381aa48c3fa), [`600e3a0`](https://github.com/ai-plugin-marketplace/tools/commit/600e3a015359fc012731c0bc7dc871c1e3d7bed5), [`9937b99`](https://github.com/ai-plugin-marketplace/tools/commit/9937b99019c42789fe3d29bc7e6d84decc4776a5), [`feabd3b`](https://github.com/ai-plugin-marketplace/tools/commit/feabd3b54debf89cef04d19725bf3975b7b95e40)]:
  - @ai-plugin-marketplace/core@0.7.0

## 0.4.0

### Minor Changes

- [#28](https://github.com/ai-plugin-marketplace/tools/pull/28) [`38e53a7`](https://github.com/ai-plugin-marketplace/tools/commit/38e53a7bebfae7f4423d21907e52f36a3039ea38) Thanks [@mike-north](https://github.com/mike-north)! - Recognize the new `open-plugins` target across the CLI. `aipm list-targets` now lists
  `open-plugins`, `aipm scaffold` includes it in the default envelope (emitting `.plugin/plugin.json`
  and a repo-root `marketplace.json`), and `aipm add-target <plugin> open-plugins`, `aipm build`, and
  `aipm validate` handle it like any other host target.

### Patch Changes

- Updated dependencies [[`0f4eece`](https://github.com/ai-plugin-marketplace/tools/commit/0f4eecea4ced472e6723a1bfa37016496cdb88b1), [`a560f7c`](https://github.com/ai-plugin-marketplace/tools/commit/a560f7c239bca0b5c1264240ec41739846fe5cfa), [`38e53a7`](https://github.com/ai-plugin-marketplace/tools/commit/38e53a7bebfae7f4423d21907e52f36a3039ea38)]:
  - @ai-plugin-marketplace/core@0.6.0

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
