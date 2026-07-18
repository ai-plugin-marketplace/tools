# @ai-plugin-marketplace/core

## 0.8.0

### Minor Changes

- [#72](https://github.com/ai-plugin-marketplace/tools/pull/72) [`6100387`](https://github.com/ai-plugin-marketplace/tools/commit/6100387eefbce1604220a9832ed44c2fb7533883) Thanks [@mike-north](https://github.com/mike-north)! - Add `aipm lint [path] [--as <mode>] [--format text|json|sarif] [--rule <id>=<severity> ...]`, exposing the lint engine core ([#61](https://github.com/ai-plugin-marketplace/tools/issues/61)) via the CLI with machine-readable output.
  - `text` (default): grouped by file as `file:line:col ruleId severity message`; `--verbose` appends the docs URL; diagnostics without a `range` render as `file ruleId severity message` (position segment omitted, never zero-filled).
  - `json`: the raw `Diagnostic[]` plus a summary envelope (`errorCount`/`warnCount`/`infoCount`/`fileCount`).
  - `sarif`: SARIF 2.1.0, one `rules[]` entry per distinct rule id — validated in tests against the official SARIF 2.1.0 JSON Schema.
  - Exit codes: `0` no `error`-severity diagnostics, `1` errors present, `2` usage error (unknown `--format`, malformed `--rule`, or an unsupported `--as` mode — only `aipm-repo` is implemented; foreign discovery modes are a later issue).
  - `--rule <id>=<severity>` (repeatable) overrides a rule's severity post-hoc, or drops its diagnostics entirely with `=off`.
  - New core export: `applyRuleSeverityOverrides(diagnostics, overrides)`, the pure filter backing `--rule`.
  - `aipm validate` behavior and exit codes are unchanged.

- [#70](https://github.com/ai-plugin-marketplace/tools/pull/70) [`2b34d54`](https://github.com/ai-plugin-marketplace/tools/commit/2b34d547c3a0ff459198a87eb22e446a5c5d5b52) Thanks [@mike-north](https://github.com/mike-north)! - Add the position-aware lint engine core (`Diagnostic`/`Rule`/document-layer types, `lint()`) and migrate every existing `validate()` check onto it, with `aipm validate` behavior unchanged.
  - New `packages/core/src/lint/` module: `Diagnostic`, `Range`, `Rule`, `RuleContext` types (L-D1/L-D4), a position-aware document layer for JSON (`jsonc-parser`), YAML (the `yaml` package's CST), and markdown frontmatter, and a pure `diagnosticToFinding()` mapping back to the legacy `Finding` shape.
  - Every existing validate check (envelope shape, per-target schema, envelope adherence, frontmatter parsing, name consistency, MCP key sync, marketplace registration, freshness, default-marketplace-name) is now backed by a `Rule` object carrying its legacy `FindingCode`.
  - Four new `correctness/*` rules: `broken-file-ref`, `unknown-hook-event`, `invalid-matcher`, `duplicate-component-name`.
  - New public exports: `lint(path, options): Promise<LintResult>`, plus `Diagnostic`, `Range`, `Rule`, `RuleContext`, `Document`/`JsonDocument`/`YamlDocument`/`FrontmatterDocument`, `Fix`, `Position`, `LintOptions`, `LintResult`, and `ConfigCache`.
  - `jsonc-parser` is now a direct dependency (previously transitive only).

### Patch Changes

- [#60](https://github.com/ai-plugin-marketplace/tools/pull/60) [`d1e1af3`](https://github.com/ai-plugin-marketplace/tools/commit/d1e1af3f0527c66de15839204395b8024b5a86b1) Thanks [@mike-north](https://github.com/mike-north)! - Anchor the Cursor controller-shim invocation to `${CLAUDE_PLUGIN_ROOT:-.}` instead of a cwd-relative
  path. The 0.7.0 transform emitted gating hook commands as `node ./hooks/cursor-shim.mjs …`, which
  assumed Cursor runs plugin hook commands with cwd = plugin root — an assumption Cursor does not
  guarantee. Because shimmed entries set `failClosed: true`, a shim path that failed to resolve did
  not merely disable the gate: `node` exited "Cannot find module" and **every gated tool call was
  denied** for that plugin under Cursor.

  The emitted command is now
  `node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/cursor-shim.mjs" <event> -- '<handler>'` (double-quoted, so a
  plugin root containing spaces survives shell expansion). The `:-.` fallback matters because Cursor's
  behavior differs by consumption layout: for an **installed plugin**, `${CLAUDE_PLUGIN_ROOT}` is set
  to the plugin's install path (confirmed only by Cursor staff forum posts, not the official docs), so
  the invocation anchors there regardless of cwd; for **project-level/colocated** hooks (a project's
  own `.cursor/hooks.json`), Cursor does not set the variable at all — verified empirically against a
  real `cursor-agent` build — so an unconditional `${CLAUDE_PLUGIN_ROOT}` anchor would expand to an
  empty string and, combined with `failClosed: true`, deny every gated call. The `.` fallback resolves
  relative to cwd (project root for project-level hooks), preserving the previously-working colocated
  behavior.

  The enforcement UAT now covers both layouts explicitly: a project-level/colocated scenario with
  `CLAUDE_PLUGIN_ROOT` deleted from the spawn environment, and an installed-plugin scenario with the
  hook cwd and the shim directory deliberately different and `CLAUDE_PLUGIN_ROOT` set — the case the
  original workspace-colocated UAT could not detect. ([#56](https://github.com/ai-plugin-marketplace/tools/issues/56))

## 0.7.0

### Minor Changes

- [#40](https://github.com/ai-plugin-marketplace/tools/pull/40) [`8251430`](https://github.com/ai-plugin-marketplace/tools/commit/825143089227710e6174ac8a71804381aa48c3fa) Thanks [@mike-north](https://github.com/mike-north)! - Contract-translate Cursor controller hooks with a generated fail-closed shim. The shipped Cursor
  hooks transform is observer-only: a Claude-authored block/deny gate emitted through it fails OPEN on
  Cursor, because the two harnesses' handler contracts diverge on tool identity (`Shell` vs `Bash`),
  event casing, control-output shape, and failure default. `aipm build` now translates that contract
  for gating events so controller hooks enforce correctly.

  Classification is static, by event: a committed `GATING_EVENTS` set (`PreToolUse`,
  `UserPromptSubmit`) is treated as controllers; `PostToolUse`/`Stop` fire after the decision point,
  cannot block, and stay on the byte-identical observer path. For a gating event, each generated
  `hooks/cursor.json` entry's `command` becomes `node ./hooks/cursor-shim.mjs <cursorEvent> --
<original handler command>` with `failClosed: true` (the handler keeps its own args verbatim after
  the `--` boundary).

  When a plugin has at least one gating-event hook, the build additionally emits a static Node runner
  `hooks/cursor-shim.mjs` plus its `hooks/cursor-shim.mjs.generated` sidecar sentinel (the runner is
  pure executable JS, so the sentinel lives in the companion file). The runner reads Cursor's hook
  stdin, translates it to a Claude envelope (`Shell` → `Bash`, PascalCase event, `session_id` /
  `tool_input.command` pass-through), spawns the handler, and translates the handler's Claude control
  output back to Cursor's flat control JSON (`permissionDecision` → `permission`; `decision:"block"` +
  reason → `permission:"deny"` + `agent_message`; `beforeSubmitPrompt` block →
  `{ continue: false, user_message }`). It is fail-closed: a non-zero handler exit, malformed handler
  output, bad arguments, or a spawn error emit a deny and exit 2, always as valid JSON. The
  `cursorHooksFileSchema` now accepts `failClosed` on an entry, and all three artifacts are
  freshness-checked byte-for-byte.

- [#54](https://github.com/ai-plugin-marketplace/tools/pull/54) [`600e3a0`](https://github.com/ai-plugin-marketplace/tools/commit/600e3a015359fc012731c0bc7dc871c1e3d7bed5) Thanks [@mike-north](https://github.com/mike-north)! - `GeneratedFile.target` now accepts `'shared'` in addition to a `TargetId` (the new
  `GeneratedFileTarget = TargetId | 'shared'` type). Two build artifacts genuinely have no single
  owning target — `hooks/payload-adapter` (and its sidecar), emitted for any plugin authoring hooks
  regardless of which targets it declares, and the generated-root sidecar manifest
  (`.aipm/generated-root.json`), which spans every emitted single-artifact-host/registry owner — and
  were previously attributed to an arbitrary, deterministically-chosen single target as a workaround.
  Both now report `target: 'shared'` instead.

  Consumers reading `BuildResult.artifacts[].target` and narrowing on `TargetId` should account for
  the new `'shared'` value; a `switch` over `TargetId` alone will no longer be exhaustive against
  `GeneratedFileTarget`.

- [#49](https://github.com/ai-plugin-marketplace/tools/pull/49) [`feabd3b`](https://github.com/ai-plugin-marketplace/tools/commit/feabd3b54debf89cef04d19725bf3975b7b95e40) Thanks [@mike-north](https://github.com/mike-north)! - Emit a generated cross-harness hook payload adapter (`hooks/payload-adapter`) for every plugin
  that authors `hooks/claude.yaml`. `hooks/claude.yaml` is authored once in the Claude Code dialect;
  Codex is near-identical but not quite (`tool_response` vs `tool_output`, extra additive fields), so
  plugin hook handler code previously had to re-derive those deltas by hand. The adapter is a static
  `sh` + `jq` filter, emitted regardless of which target(s) the plugin's envelope declares, that
  normalizes any supported harness's raw hook stdin payload into one documented canonical shape (the
  Claude Code hook envelope, additively extended) — see `docs/specs/payload-adapter.md`.

  Behavior: the canonical shape is the Claude Code hook envelope; Codex's `tool_response` gains a
  canonical `tool_output` alongside it (never removing the original field); a `harness: {name}`
  envelope is added, detected from Codex's additive-only fields (`turn_id`/`model`/`tool_response`/
  `agent_transcript_path`), then the `CODEX_HOME` environment variable as a secondary signal, then a
  recognized PascalCase `hook_event_name`, else `"unknown"`; `is_subagent` is added for every payload
  from a non-empty `agent_id`; `payload-adapter --schema` prints the canonical JSON Schema plus a
  single-sourced contract version and exits 0 without reading stdin; a missing `jq` on `PATH`
  degrades to a byte-for-byte stdin passthrough, exit 0 (never breaks a hook chain); output key order
  is sorted at every nesting level for deterministic, golden-able output.

  The adapter is a byte-exact static asset (like the existing Cursor controller-hook shim) — every
  plugin that authors hooks receives identical bytes, and `hooks/payload-adapter.generated` carries
  its sidecar sentinel so freshness compares it byte-for-byte alongside the existing generated hook
  artifacts.

### Patch Changes

- [#43](https://github.com/ai-plugin-marketplace/tools/pull/43) [`9937b99`](https://github.com/ai-plugin-marketplace/tools/commit/9937b99019c42789fe3d29bc7e6d84decc4776a5) Thanks [@mike-north](https://github.com/mike-north)! - Harden the generated Cursor controller-hook shim (`hooks/cursor-shim.mjs`).
  - **Shell fidelity.** The transform now embeds the original Claude handler command as a single
    POSIX-single-quoted token after the `--` sentinel, and the runner executes everything after `--`
    through a shell (`spawnSync(cmd, { shell: true, … })`) — matching Claude's own `sh -c` hook
    model. A handler command using env-var refs, quoting, or its own args now execs correctly on
    Cursor instead of failing to run (and denying).
  - **No stdout truncation.** The runner flushes stdout before exiting
    (`process.stdout.write(json, () => process.exit(code))`) on the fail-closed, allow/continue, and
    interpret paths, so a large allow decision is never truncated into malformed JSON.
  - **Explicit spawn `maxBuffer` (64 MB).** A handler emitting more than the default 1 MB of stdout is
    no longer misread as a spawn failure and denied.
  - **Single YAML parse for Cursor.** "Has a gating hook?" is derived from the already-converted
    Cursor document rather than a second parse of the source.
  - **Single source of truth for the tool table.** The runner's `CURSOR_TO_CLAUDE_TOOLS` is generated
    from the exported const at emit time (stable, sorted key order — the `.mjs` stays
    byte-deterministic), so the two copies cannot drift.

  Fail-closed safety is unchanged: a non-zero handler exit, malformed handler output, bad argv, spawn
  failure, or internal error still emits a deny and exits 2, always as valid JSON.

## 0.6.0

### Minor Changes

- [#35](https://github.com/ai-plugin-marketplace/tools/pull/35) [`0f4eece`](https://github.com/ai-plugin-marketplace/tools/commit/0f4eecea4ced472e6723a1bfa37016496cdb88b1) Thanks [@mike-north](https://github.com/mike-north)! - Add a Cursor hooks build target. When a plugin's envelope includes `cursor` and it ships a
  `hooks/claude.yaml` source, `aipm build` now emits a Cursor-format `hooks/cursor.json` derived
  mechanically from that source — parallel to the existing `claude` → `hooks/claude.json` and
  `gemini` → `hooks/hooks.json` fan-out.

  The transform renames Claude events to Cursor's camelCase vocabulary (`PreToolUse` → `preToolUse`,
  `PostToolUse` → `postToolUse`, `Stop` → `stop`, `UserPromptSubmit` → `beforeSubmitPrompt`),
  translates matcher tool names (`Bash` → `Shell`; `Read`/`Write`/`Edit`/`Grep` identity; unmapped
  matchers pass through), and reshapes Claude's nested matcher blocks into Cursor's flat
  `{ command, type?, matcher? }` entries under a `{ version: 1, hooks: … }` envelope. Source events
  with no Cursor equivalent are dropped. The generated file carries the standard `_generated`
  sentinel and is freshness-checked like the other hook JSONs.

  `aipm validate` now validates a present `hooks/cursor.json` against a strict schema (HARD
  `schema-invalid` on failure), and the Cursor manifest guidance points the `hooks` field at
  `./hooks/cursor.json` instead of the Claude-format `hooks/claude.json`.

- [#30](https://github.com/ai-plugin-marketplace/tools/pull/30) [`a560f7c`](https://github.com/ai-plugin-marketplace/tools/commit/a560f7c239bca0b5c1264240ec41739846fe5cfa) Thanks [@mike-north](https://github.com/mike-north)! - Add soft Open Plugins conformance advisories on the native `claude`/`cursor`/`codex` targets.

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

- [#28](https://github.com/ai-plugin-marketplace/tools/pull/28) [`38e53a7`](https://github.com/ai-plugin-marketplace/tools/commit/38e53a7bebfae7f4423d21907e52f36a3039ea38) Thanks [@mike-north](https://github.com/mike-north)! - Add Open Plugins as a 7th host target (`open-plugins`).

  Open Plugins ([open-plugins.com](https://open-plugins.com), v1.0.0) is a vendor-neutral external
  standard for the on-disk shape of an AI-assistant plugin. Declaring `'open-plugins'` in a plugin's
  envelope now emits an Open-Plugins-conformant `.plugin/plugin.json` manifest and a repo-root
  `marketplace.json` registry (the 4th generated registry, at Open Plugins lookup position 1),
  projected from the same authored source that feeds every other target.

  The target validates the manifest against the Open Plugins name grammar and component-path rules
  (each path must be `./`-relative with no `..`), checks that declared component paths resolve on
  disk, and enforces metadata-directory isolation via a new hard `metadata-dir-isolation` finding
  (the `.plugin/` directory must contain only `plugin.json`). Adds `'open-plugins'` to the `TargetId`
  union and `'metadata-dir-isolation'` to the `FindingCode` union (both additive).

  The repo-root `marketplace.json` is protected by the generated-root collision guard: a pre-existing
  `marketplace.json` the toolkit did not generate raises a hard `root-artifact-collision` and is never
  overwritten or orphan-removed.

## 0.5.0

### Minor Changes

- [#23](https://github.com/ai-plugin-marketplace/tools/pull/23) [`8c7bef1`](https://github.com/ai-plugin-marketplace/tools/commit/8c7bef1d65a3614924775c643550d384d342d7a7) Thanks [@mike-north](https://github.com/mike-north)! - Validate that plugin frontmatter parses as strict YAML. `runValidate` now strict-parses the YAML frontmatter of every `skills/<name>/SKILL.md`, `agents/*.md`, `commands/*.md`, and `POWER.md`, emitting a hard `frontmatter-invalid` finding when it fails. This catches frontmatter that loads on a lenient host (Claude Code) but is rejected by a strict one (e.g. Codex's skill loader) — the classic case being an unquoted `": "` (colon-space) inside a `description` value, which YAML reads as an illegal nested mapping. Adds the `frontmatter-invalid` value to the `FindingCode` union.

### Patch Changes

- [#25](https://github.com/ai-plugin-marketplace/tools/pull/25) [`0bfc191`](https://github.com/ai-plugin-marketplace/tools/commit/0bfc191e54cb76d5ca223bfec6f5efbd223fcbd9) Thanks [@mike-north](https://github.com/mike-north)! - Accept a relative `./*.json` path string for `mcpServers` in the Claude and Cursor plugin manifest schemas (a union with the existing inline-record form), matching the Codex schema and the `hooks` field. Previously Claude/Cursor manifests that referenced their MCP config by path (e.g. `"mcpServers": "./.mcp.json"`) were rejected with `schema-invalid` even though that is the form Claude Code installs from.

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
