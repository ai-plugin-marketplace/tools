# ai-plugin-marketplace — Harness-Config Lint Engine Specification

**Status:** Draft (design-authoritative; implementation PRs follow this document)
**Spec version:** 0.2.0
**Last updated:** 2026-07-19
**Scope:** Evolves the toolkit's validation surface into a general-purpose linter for AI-harness
configuration — a position-aware rule engine in `@ai-plugin-marketplace/core`, a new `aipm lint`
CLI command with machine-readable output, published JSON Schemas, and an
`@ai-plugin-marketplace/eslint-plugin` package. Companion to `architecture.md` (§8.1 public API,
§10 validation contract, §10.5 freshness) and `adapter-system.md` (§4.2.1 cross-harness payload
and assertability tables, which ground the portability rules).

> **Note to future readers.** This spec is design-authoritative documentation, per the repo's
> spec-first convention. It records what the lint engine is, why it supersedes the flat
> `Finding` model, and which invariants (validate back-compat, zod as single schema authority,
> position fidelity) implementation must hold. When the design evolves, update this document in
> the same change that moves the code.

---

## 1. Purpose and scope

### 1.1 The goal

Make this toolkit the best available way to lint harness configuration — not only the
superposition-authored plugin repos it already builds, but **any** harness config a user has on
disk: a hand-written Claude Code plugin, a bare `skills/` directory, an Open Plugins tree, or a
`.claude/` user/project config directory.

### 1.2 What existed pre-engine (historical baseline, as of 2026-07-16)

> **Superseded.** This subsection is kept as the historical starting point the engine work (§6
> items 1–2) replaced. It no longer describes the shipped state — see §6 for what is SHIPPED
> today and the current `packages/core/src/lint/` tree for the live implementation.

- The only lint surface was `validate()` (`packages/core/src/pipeline/validate.ts`, orchestrated
  per `architecture.md` §10) plus the CLI's text renderer in `packages/cli/src/run.ts`.
- Diagnostics were `Finding` objects: two severities (`hard`/`soft`), a closed `FindingCode`
  enum, message strings with no line/column positions, no per-rule configuration, no
  machine-readable output.
- All schema validation was zod, private to core; no JSON Schemas were published.
- Discovery required an aipm-authored repo (`aipm.config.ts` per plugin); foreign config could
  not be linted at all.
- No ESLint integration existed for consumers (the repo's own `eslint.config.mjs` is dev-only).

### 1.3 Non-goals

- **No LSP / language server** in this spec's scope (the published JSON Schemas deliver most
  editor value via existing JSON/YAML language servers).
- **No auto-fix in v1** beyond the `fix` field being present in the diagnostic model (L-D2);
  fix application is follow-on work.
- **No normalization of user-authored semantics** — e.g. the agent-UX rules judge description
  _quality signals_, they do not rewrite descriptions.
- **No new authoring format.** The engine lints existing formats; it does not introduce one
  (architecture.md §14 holds).

---

## 2. The engine (`packages/core/src/lint/`)

### 2.1 Diagnostic model

> **L-D1 (normative).** The engine's unit of output is a `Diagnostic`:
>
> ```ts
> interface Diagnostic {
>   ruleId: string; // e.g. 'correctness/broken-file-ref'
>   category: 'schema' | 'correctness' | 'security' | 'agent-ux' | 'portability';
>   severity: 'error' | 'warn' | 'info';
>   message: string;
>   file: string; // repo-relative path
>   range?: Range; // { start: {line, col}, end: {line, col} }, 1-indexed
>   docsUrl: string; // generated per-rule docs page
>   hint?: string;
>   fix?: Fix; // reserved; not applied in v1
>   legacyCode?: FindingCode; // present when the rule migrates an existing check
> }
> ```
>
> `range` is optional only for diagnostics that are genuinely file-scoped (e.g. "file missing");
> any diagnostic derived from parsed content MUST carry a range.

> **L-D2 (normative).** `Finding` and `FindingCode` remain public API. `validate()` is
> reimplemented as a profile over the engine: each legacy check becomes a rule carrying its
> `legacyCode`, and a pure mapping `diagnosticToFinding()` reproduces today's findings byte-alike
> (same codes, severities via `error→hard` / `warn|info→soft` with the CI freshness escalation
> preserved). `aipm validate` output and exit codes do not change.
>
> **`file` ↔ `Finding.plugin` recovery.** A `Finding` has no `file`; it has an optional `plugin`
> name. `findingToDiagnostic()` (the `Finding → Diagnostic` direction, used by legacy-wrapper
> rules that reuse an existing `validate()` check's logic) sets `Diagnostic.file` to
> `finding.plugin` when present, or the sentinel string `'(repo)'` for a repo-scoped finding with
> no owning plugin. `diagnosticToFinding()` (the inverse) recovers `Finding.plugin` by treating
> `Diagnostic.file === '(repo)'` as "no plugin" and every other value as the plugin name verbatim
> — there is no path-based lookup; the sentinel round-trips losslessly because legacy checks never
> emit a real file path in this field.

### 2.2 Position-aware document layer

> **L-D3 (normative).** All content parsing flows through a document layer that retains source
> positions: JSON via `jsonc-parser` (offset→line/col), YAML via the `yaml` package's CST,
> markdown frontmatter via offset-tracked extraction. Zod validation runs against the plain
> values, and zod issue `path`s are resolved back to document nodes to produce ranges. No rule
> re-parses files ad hoc. `jsonc-parser` is used **only for position tracking**: host-conformant
> JSON manifests remain strict JSON, and comments encountered in them are themselves a
> `schema/*` diagnostic, not tolerated input (which is also why JSON has no inline-suppression
> channel, L-D6).

This layer is the single largest enabler of "best available": every schema error, broken
reference, and quality warning lands on a clickable `file:line:col`.

### 2.3 Rules

> **L-D4 (normative).** A rule is a module implementing:
>
> ```ts
> interface Rule {
>   meta: {
>     id: string; // '<category>/<kebab-name>'
>     category: Diagnostic['category'];
>     defaultSeverity: 'error' | 'warn' | 'info' | 'off';
>     description: string; // one-liner, feeds generated docs
>     appliesTo: DiscoveryMode[]; // which discovery modes run it (§2.4)
>   };
>   check(ctx: RuleContext): Diagnostic[] | Promise<Diagnostic[]>;
> }
> ```
>
> `RuleContext` exposes the parsed document set and workspace model read-only. Rules never do
> their own file discovery or parsing. Rule ids are additive public API (new rule = MINOR,
> removal/rename = MAJOR), mirroring the existing `FindingCode` policy.
>
> **Severity may be a function of `RuleContext`.** `meta.defaultSeverity` is the rule's
> unconditional default, but a `check()` implementation MAY emit diagnostics whose per-diagnostic
> `severity` differs based on context — the shipped example is `ctx.ci`: the freshness rules
> (`correctness/freshness`, `correctness/root-artifact-freshness`) escalate a mismatch from `warn`
> (local) to `error` (CI), per §10.2's CI/local freshness distinction. `applyRuleSeverityOverrides`
> (the CLI's `--rule <id>=<severity>` handling, L-D6) still applies uniformly on top of whatever
> severity a rule computed — user overrides always win over context-computed severity.

### 2.4 Discovery modes (foreign config support)

> **L-D5 (normative).** The engine discovers lintable units via pluggable modes, auto-detected
> from the target path and forceable via `--as`:
>
> | Mode                 | Detection signal                                                                               | Unit                  |
> | -------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
> | `aipm-repo`          | `aipm.config.ts` / `aipm.repo.ts` (existing discovery)                                         | full repo, all checks |
> | `claude-plugin`      | `.claude-plugin/plugin.json`                                                                   | one plugin tree       |
> | `open-plugins`       | `.plugin/plugin.json`                                                                          | one Open Plugins tree |
> | `skills-dir`         | directory of `*/SKILL.md` (or a single `SKILL.md`)                                             | skills only           |
> | `claude-user-config` | `settings.json` + any of `skills/`, `agents/`, `commands/`, `hooks/` in a `.claude`-shaped dir | user/project config   |
>
> Detection evaluates **all** signals at the target path. `aipm-repo` takes precedence when it
> matches (it subsumes the other shapes: an aipm repo legitimately contains plugin trees and
> skills). Absent an `aipm-repo` match, exactly one remaining signal must match; if more than one
> does, detection is a **CLI usage error** (see below) telling the user to pass `--as` — it never
> guesses. Discovery-mode names reuse established vocabulary (`open-plugins`
> matches the `TargetId` spelling). Cross-file semantic rules that require the aipm workspace model (freshness,
> mcp-key-sync, name-consistency, version-consistency, envelope adherence) declare
> `appliesTo: ['aipm-repo']` and are
> silently absent in foreign modes — foreign configs get every rule whose inputs exist.
>
> **Ambiguous discovery is a CLI usage error, not a `Diagnostic`.** When detection cannot settle
> on exactly one mode (no signal matches, or more than one non-`aipm-repo` signal matches), the
> CLI reports the failure on stderr and exits **2** — the same "malformed invocation" exit code
> `aipm lint` already uses for a bad `--as`/`--format`/`--rule` value (`packages/cli/src/run.ts`'s
> `case 'lint'`). It is never surfaced as a `Diagnostic` in `text`/`json`/`sarif` output: a usage
> error means the tool could not even determine what to lint, so there is no diagnostic stream to
> emit into.

### 2.5 Configuration and suppression

> **L-D6 (normative).** Rule configuration lives in a `lint` block of `aipm.config.ts` /
> `aipm.repo.ts`, or a standalone `aipm.lint.ts` for foreign-mode use: per-rule severity
> override or `'off'`, plus path ignore globs. Inline suppression is supported where the host
> format has comments — `# aipm-lint-disable-next-line <ruleId>` in YAML and
> `<!-- aipm-lint-disable-next-line <ruleId> -->` in markdown. JSON files have no comment
> channel; suppression there is config-file-only. Unknown rule ids in config or suppressions are
> themselves a `warn` diagnostic (typo protection).
>
> **Known gap — L-D6's config/suppression machinery is design-only today, not shipped.** `lint()`
> currently applies no `lint`-block config and no inline suppression at all; the only severity
> lever that exists today is the CLI's `--rule <id>=<severity>` override (§4.1), which is separate
> from and does not require L-D6. The three conventions below are the normative target this
> machinery must follow once built — tracked as part of §6 item 3 (foreign discovery modes), since
> `aipm.lint.ts` has no purpose while `--as` supports only `aipm-repo`. They are **not** current
> behavior.
>
> **Config precedence (follow-up, §6 item 3).** `aipm.lint.ts` is **foreign-mode-only** — a
> standalone config for a target that has no `aipm.config.ts` at all. In a repo that has
> `aipm.config.ts` (i.e. discovery resolved `aipm-repo`), that repo's `lint` block is the sole
> source of rule config; a coexisting `aipm.lint.ts` is **ignored, with a `warn` diagnostic**
> pointing at the winning `aipm.config.ts` `lint` block, rather than silently merged or silently
> dropped — an author who leaves a stale `aipm.lint.ts` around after adopting `aipm.config.ts`
> gets a visible signal, not silent divergence between the two files.
>
> **`disable-next-line` line matching (follow-up, §6 item 3).** A
> `# aipm-lint-disable-next-line <ruleId>` / `<!-- aipm-lint-disable-next-line <ruleId> -->`
> comment will suppress a diagnostic **iff** the diagnostic's
> `range.start.line === commentLine + 1` (1-indexed, per L-D1) — i.e. it suppresses only the
> single line immediately following the comment, not the comment's own line and not a multi-line
> span. A diagnostic with no `range` (file-scoped, L-D1) can never be line-suppressed — only
> per-rule config (`'off'` or a path ignore glob) can silence it.

---

## 3. Rules v1

### 3.1 `schema/*` — structural conformance

The existing zod schemas (per-target `schemas.ts`, config schemas in `config.ts`), re-emitted
through L-D3 so every issue has a range. Zod remains the sole authority (L-D8). Two migrated
rules carry this category:

- `schema/envelope-shape` — `aipm.config.ts` loads and parses strictly against the envelope
  schema. Fires on _any_ failure to resolve the envelope, not only a schema violation: a missing
  `aipm.config.ts` in a plugin-shaped directory, a file that cannot be imported (syntax error, no
  usable default export), or a file that imports but violates the schema (#101). The first two
  carry the config loader's own message; the third expands into one diagnostic per Zod issue. In
  every case this mirrors `validate()`'s `envelope-invalid` for the same tree — `lint`, `validate`
  and `build` must agree rather than one staying silent; legacy code `envelope-invalid`.
- `schema/target-conformance` — every target manifest in a plugin's envelope parses against that
  target's current schema; legacy codes `schema-invalid`, plus the Open Plugins-specific
  `metadata-dir-isolation` and `open-plugins-conformance` (soft, advisory-only) findings the same
  underlying check can also emit (see the migration table, §3.6).

`repo-config-invalid` (a malformed `aipm.repo.ts` that `discoverPlugins()` fails to load, or a
malformed `aipm.workspace.ts` that `loadWorkspaceConfig()` fails to load) is a repo-scoped
orchestration finding emitted directly by `validate()`'s top-level dispatch (`runValidate()`,
`packages/core/src/pipeline/validate.ts`), not yet wrapped as its own `Rule` — see §3.6's
migration table for the full accounting.

### 3.2 `correctness/*` — things that silently break at runtime

Migrations of every existing correctness-category check, one rule per legacy code (see §3.6 for
the complete `FindingCode → rule` accounting across every category):

- `correctness/envelope-adherence` — legacy code `envelope-adherence`.
- `correctness/name-consistency` — legacy code `name-consistency`.
- `correctness/version-consistency` — legacy code `version-consistency` (#84).
- `correctness/mcp-key-sync` — legacy code `mcp-key-sync`.
- `correctness/marketplace-registration` — legacy code `marketplace-registration`.
- `correctness/default-marketplace-name` — legacy code `default-marketplace-name` (default
  severity `warn`; the only correctness-category rule that isn't `error` by default).
- `correctness/frontmatter-invalid` — legacy code `frontmatter-invalid` (frontmatter parse
  failures).
- `correctness/freshness` — legacy code `freshness` (generated hook JSONs / `dist/**` bundles,
  plugin-scoped; and generated marketplace registries, repo-scoped — two rule instances share
  this one legacy code and rule id, per §3.6).
- `correctness/root-artifact-freshness` — legacy codes `single-artifact-host`,
  `root-artifact-collision` (both always `error`), and `freshness` (repo-root artifacts for
  single-artifact-host targets, CI/local-sensitive per L-D4's severity-as-function-of-context).

Plus four new rules with no legacy `Finding`/`FindingCode` predecessor:

- `correctness/broken-file-ref` — manifest and frontmatter references to files that don't exist.
- `correctness/unknown-hook-event` — event names outside the host's recognized set.
- `correctness/invalid-matcher` — hook matchers that are not valid regexes.
- `correctness/duplicate-component-name` — colliding skill/agent/command names within a unit.

> **L-D11 (normative) — generator-stamp normalization, inherited by the freshness rules.** Every
> sentinel-carrying generated artifact (`_generated.version` in JSON, `# version:` in inline/
> sidecar sentinels) records the `@ai-plugin-marketplace/core` version that produced it
> (`architecture.md` §4.3.1, #81). The `correctness/freshness` and
> `correctness/root-artifact-freshness` rules compare on-disk content against freshly-generated
> content **modulo this stamp**: `withoutGeneratorVersion()` (`packages/core/src/pipeline/sentinel.ts`)
> strips only the stamp token via a minimal string edit before the comparison, so an
> artifact that differs from a fresh build _only_ in its stamped generator version is not flagged
> stale — a version bump alone must not mark every committed artifact stale (version safety is the
> build downgrade guard's job, §4.3.1 of `architecture.md`, not freshness's). The normalization is
> still discriminating: a formatting-only hand-edit (e.g. a reindented JSON artifact with
> identical data) remains distinguishable and IS flagged stale, because only the stamp token is
> stripped, not the rest of the content. This exact round-trip/discrimination property is asserted
> by `packages/core/src/pipeline/sentinel.test.ts`'s version-agnostic-normalization suite
> (`withoutGeneratorVersion` round-trip plus the "does NOT mask a formatting-only edit" case) —
> the freshness-check analogue of L-D8's JSON Schema round-trip test.

### 3.3 `security/*` — dangerous config

- `security/embedded-secret` — secret-shaped values (key/token patterns) in manifests, MCP
  configs, hooks, settings.
- `security/broad-permission-allow` — `Bash(*)`-class and similarly unbounded `permissions.allow`
  entries in Claude settings.
- `security/unsafe-hook-command` — hook commands matching pipe-to-shell (`curl … | sh`) or
  eval-of-stdin shapes.
- `security/mcp-plaintext-credential` — credentials inline in MCP server env/args instead of a
  reference.

Default severities: `warn` (heuristic rules must not block CI by default; users opt up).

### 3.4 `agent-ux/*` — will the model actually use this config well

- `agent-ux/description-triggering` — skill/agent descriptions missing "use when" framing, too
  short/long, or non-specific.
- `agent-ux/frontmatter-hygiene` — unknown keys, empty required prose fields.
- `agent-ux/oversized-skill` — SKILL.md bodies past a token-budget threshold (configurable).

Default severity: `info` (advisory; these are judgment heuristics).

### 3.5 `portability/*` — superposition payoff

- `portability/untranslatable-feature` — authored features that do not survive translation to a
  declared target (grounded in `adapter-system.md` §4.2.1 assertability tables; e.g. a hook
  event a target cannot express). Fires only for targets in the plugin's envelope.

> **L-D7 (normative).** Every heuristic rule (security, agent-ux) documents its false-positive
> posture on its docs page and defaults to a non-blocking severity. Only deterministic rules
> (schema, correctness) may default to `error`.

### 3.6 `FindingCode` → rule migration table (normative)

> **L-D10 (normative).** This table is the single source of truth for how every closed
> `FindingCode` (`packages/core/src/pipeline/types.ts`) maps onto a registered rule
> (`packages/core/src/lint/rules/index.ts`'s `ALL_RULES`), and MUST be updated in the same change
> that adds, removes, or renames a rule or a `FindingCode`. `defaultSeverity` is the owning rule's
> `meta.defaultSeverity`; because several of these rules wrap a legacy check whose _per-finding_
> severity can vary (e.g. the freshness CI/local escalation, L-D4), the severity actually emitted
> for a given diagnostic is not always the rule's default — see each row's note.

| `FindingCode`              | `ruleId`                               | `category`    | `defaultSeverity` | Notes                                                                                                                            |
| -------------------------- | -------------------------------------- | ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `envelope-invalid`         | `schema/envelope-shape`                | `schema`      | `error`           |                                                                                                                                  |
| `repo-config-invalid`      | _(none — repo-scoped orchestration)_   | —             | —                 | Not yet wrapped as a `Rule`; emitted directly by `validate()`'s top-level dispatch.                                              |
| `schema-invalid`           | `schema/target-conformance`            | `schema`      | `error`           |                                                                                                                                  |
| `metadata-dir-isolation`   | `schema/target-conformance`            | `schema`      | `error`           | Open Plugins `.plugin/` metadata-dir isolation; same rule as `schema-invalid`.                                                   |
| `open-plugins-conformance` | `schema/target-conformance`            | `schema`      | `error`           | Emitted `soft` (advisory) per its own finding; the rule's _default_ is `error`.                                                  |
| `envelope-adherence`       | `correctness/envelope-adherence`       | `correctness` | `error`           |                                                                                                                                  |
| `name-consistency`         | `correctness/name-consistency`         | `correctness` | `error`           |                                                                                                                                  |
| `version-consistency`      | `correctness/version-consistency`      | `correctness` | `error`           | #84.                                                                                                                             |
| `mcp-key-sync`             | `correctness/mcp-key-sync`             | `correctness` | `error`           |                                                                                                                                  |
| `marketplace-registration` | `correctness/marketplace-registration` | `correctness` | `error`           |                                                                                                                                  |
| `default-marketplace-name` | `correctness/default-marketplace-name` | `correctness` | `warn`            |                                                                                                                                  |
| `frontmatter-invalid`      | `correctness/frontmatter-invalid`      | `correctness` | `error`           |                                                                                                                                  |
| `freshness`                | `correctness/freshness`                | `correctness` | `error`           | Two rule instances share this id: plugin-scoped (hook JSONs/`dist/**`) and repo-scoped (registries). CI/local severity per L-D4. |
| `freshness`                | `correctness/root-artifact-freshness`  | `correctness` | `error`           | Third emitter of `freshness`, alongside `single-artifact-host`/`root-artifact-collision` below.                                  |
| `single-artifact-host`     | `correctness/root-artifact-freshness`  | `correctness` | `error`           | Always `error` (not CI/local-sensitive).                                                                                         |
| `root-artifact-collision`  | `correctness/root-artifact-freshness`  | `correctness` | `error`           | Always `error` (not CI/local-sensitive).                                                                                         |

New (non-legacy) rules — no `FindingCode` predecessor, `legacyCode` unset:

| `ruleId`                               | `category`    | `defaultSeverity` |
| -------------------------------------- | ------------- | ----------------- |
| `correctness/broken-file-ref`          | `correctness` | `error`           |
| `correctness/unknown-hook-event`       | `correctness` | `error`           |
| `correctness/invalid-matcher`          | `correctness` | `error`           |
| `correctness/duplicate-component-name` | `correctness` | `error`           |

This table's rule set matches `ALL_RULES` exactly (16 registered rules: `envelopeShapeRule`,
`targetSchemaRule`, `envelopeAdherenceRule`, `frontmatterParsesRule`, `pluginFreshnessRule`,
`brokenFileRefRule`, `unknownHookEventRule`, `invalidMatcherRule`, `duplicateComponentNameRule`,
`defaultMarketplaceNameRule`, `registryFreshnessRule`, `rootArtifactFreshnessRule`,
`nameConsistencyRule`, `versionConsistencyRule`, `mcpKeySyncRule`, `marketplaceRegistrationRule`)
and every entry in the closed `FindingCode` union (15 codes, `repo-config-invalid` explicitly
called out above as not-yet-rule-wrapped rather than omitted).

---

## 4. Surfaces

### 4.1 CLI — `aipm lint`

`aipm lint [path] [--as <mode>] [--format text|json|sarif] [--rule <id>=<severity> ...]`

- `text` (default): grouped by file, `file:line:col ruleId severity message`, docs URL on
  verbose. Diagnostics without a `range` (file-scoped, L-D1) render as
  `file ruleId severity message` — the position segment is omitted, never zero-filled.
- `json`: the `Diagnostic[]` array plus a summary envelope (`{ errorCount, warnCount, infoCount,
fileCount }`).
- `sarif`: SARIF 2.1.0, one `rule` per rule id — direct GitHub code-scanning upload.
- Exit codes: `0` no `error`-severity diagnostics, `1` errors present, `2` usage error —
  congruent with `aipm validate` today.
- `aipm validate` is retained unchanged in behavior (L-D2) and documented as the CI
  build-contract profile; `aipm lint` is the superset linter.

> **L-D12 (normative) — deterministic output ordering.** Diagnostics are sorted by
> `(file, line, col, ruleId)` before rendering, so the same lint run produces byte-identical output
> across invocations and platforms regardless of rule-execution order. `range`-less (file-scoped)
> diagnostics sort as if `line`/`col` were `0`, ahead of any ranged diagnostic in the same file, per
> L-D1's "position segment omitted, never zero-filled" _rendering_ rule (the zero is a sort key
> only, never printed). **Known gap (not fixed in this spec-only change, per the non-goals):**
> `formatLintText` (`packages/cli/src/lint-format.ts`) today sorts by `(file, line, col)` only —
> same-position diagnostics are not deterministically broken by `ruleId`, they retain
> rule-execution order — and the `json`/`sarif` builders emit diagnostics in `lint()`'s raw
> (unsorted) order rather than applying this ordering at all. Tracked as a follow-up
> implementation issue rather than fixed here.

> **L-D9 (normative) — scan scope and `fileCount`.** A lint run's scan scope is exactly the set
> of files any rule actually reads through the document layer (`RuleContext.getDocument()`,
> L-D3), across every plugin and repo-scoped context built for that run. `lint()` returns this as
> `LintResult.scannedFiles`: repo-relative paths, deduped, sorted. The `json` format's
> `summary.fileCount` is `scannedFiles.length` — **not** the number of distinct files that happen
> to carry a diagnostic. This matters because a fully clean run over many files must still report
> a nonzero, accurate `fileCount` (zero diagnostics does not mean zero files were scanned), and a
> broken manifest that a rule can't fully parse must not silently drop out of the count either. A
> file that exists on disk but that no active rule's candidate-file list includes (e.g. it's
> outside every rule's scanned-file set, or belongs to a target excluded by the plugin's
> envelope) is never counted — `fileCount` is truthful about what this run actually scanned, not
> a proxy for "every file under the plugin directory".

### 4.2 Published JSON Schemas

> **L-D8 (normative).** JSON Schemas for `plugin.json` (per target), `hooks/claude.yaml`,
> `marketplace.json`, `.mcp.json`, and SKILL/agent/command frontmatter are **generated from the
> zod schemas** (zod v4 `toJSONSchema`), never hand-authored. They ship in the core package under
> `schemas/`, are served at stable URLs, and a round-trip test asserts generated output matches
> the committed files (freshness-style). A SchemaStore submission follows once URLs are stable,
> giving zero-install editor squiggles/completion via existing JSON/YAML language servers.

### 4.3 ESLint plugin — `@ai-plugin-marketplace/eslint-plugin`

A new workspace package. Processors expose `SKILL.md` frontmatter, `hooks/claude.yaml`, and
`plugin.json` as virtual lintable files; each engine rule is wrapped as an ESLint rule delegating
to the same `check()` (no duplicated logic). Ships a flat-config `recommended` preset. ESLint's
own severity/disable machinery composes with, and does not replace, L-D6 config.

---

## 5. Docs

Per-rule documentation pages are generated from `Rule.meta` (id, description, category, default
severity, examples, false-positive posture per L-D7); `docsUrl` in every diagnostic points at
them. Generation is freshness-checked like other emitted artifacts.

> **Note — `docs-url.ts` is dangling until this item ships.** `packages/core/src/lint/rules/docs-url.ts`'s
> `docsUrlFor()` already fabricates the stable URL shape every `Diagnostic.docsUrl`
> uses (`https://ai-plugin-marketplace.dev/rules/<ruleId>`), but nothing in §6 item 7 (generated
> rule docs) has shipped yet, so those URLs 404 today. This is a spec note only — §6 item 7 is
> where `docs-url.ts` gets adopted (its URL shape becomes what the generator actually publishes
> to) or removed in favor of a different scheme; no code change to `docs-url.ts` happens in this
> spec-only change.

---

## 6. Sequencing

Spec-first, then serially unblocked fleet issues:

1. **Engine core — SHIPPED (#70).** `Diagnostic`/`Rule`/document layer; all existing validate
   checks migrated as rules (§3.6's migration table is the current, complete accounting);
   `validate()` reimplemented over the engine with byte-alike output (L-D2, proven by the existing
   validate test suite passing unmodified). Subsequently extended in place by #84
   (`correctness/version-consistency`) and #81 (generator-stamp normalization, L-D11) without
   changing this item's shipped status.
2. **CLI `aipm lint` — SHIPPED (#72).** text/json/sarif output, exit codes (`0`/`1`/`2` per §4.1);
   SARIF output validated against the SARIF 2.1.0 schema in tests. `--as` currently accepts only
   `aipm-repo` (any other value is a usage error, exit 2) — the remaining discovery modes are
   item 3 below.

Open work, re-scoped now that items 1–2 are shipped:

3. **Foreign discovery modes** (L-D5) — `claude-plugin`, `open-plugins`, `skills-dir`,
   `claude-user-config` detection and fixture trees per mode; the ambiguity-is-a-usage-error
   convention and the `aipm.lint.ts` config path (L-D6) both land with this item, since neither is
   reachable while `--as` supports only `aipm-repo`.
4. **JSON Schema generation + publishing** (L-D8).
5. **ESLint plugin package** (§4.3).
6. **Rule packs** — security, agent-ux, portability (one issue each; each rule lands with
   spec-derived positive and negative tests, per L-D7's false-positive-posture requirement).
7. **Generated rule docs** (§5) — also resolves the dangling `docs-url.ts` URL shape (§5's note).

Every issue's merge gate is the standing one: `pnpm run check` + dogfood `aipm validate` green,
plus a changeset.

---

## 7. Invariants (consolidated, normative)

A single reference gathering every L-D invariant plus the conventions that otherwise lived only
in code before this reconciliation. Each entry links back to its defining subsection; this section
does not redefine them, only indexes them.

| ID    | One-line summary                                                                                                                                                                                                                                                                                                                   | Defined in |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| L-D1  | `Diagnostic` shape; `range` required for any content-derived diagnostic.                                                                                                                                                                                                                                                           | §2.1       |
| L-D2  | `Finding`/`FindingCode` remain public API; `diagnosticToFinding()`/`findingToDiagnostic()` are the pure, lossless conversion (including the `'(repo)'` file↔plugin sentinel).                                                                                                                                                      | §2.1       |
| L-D3  | All parsing flows through the position-aware document layer; no ad hoc re-parsing.                                                                                                                                                                                                                                                 | §2.2       |
| L-D4  | Rule module shape; severity MAY be a function of `RuleContext` (e.g. `ctx.ci` freshness escalation), subject to user `--rule` overrides winning last.                                                                                                                                                                              | §2.3       |
| L-D5  | Discovery modes, `aipm-repo` precedence, and ambiguous discovery = CLI usage error (exit 2, stderr, never a `Diagnostic`).                                                                                                                                                                                                         | §2.4       |
| L-D6  | Rule config target design: `aipm.config.ts`'s `lint` block (repo) or `aipm.lint.ts` (foreign-mode-only, ignored-with-`warn` when a repo config exists); inline `disable-next-line` suppresses iff `range.start.line === commentLine + 1`. **Not shipped** — `lint()` applies no config/suppression today; tracked under §6 item 3. | §2.5       |
| L-D7  | Heuristic rules (security, agent-ux) document false-positive posture and default non-blocking; only deterministic rules (schema, correctness) may default `error`.                                                                                                                                                                 | §3.5       |
| L-D8  | Published JSON Schemas are generated from zod, never hand-authored; round-trip test asserts freshness.                                                                                                                                                                                                                             | §4.2       |
| L-D9  | Lint scan scope = files actually read via `getDocument()`; `json` format's `fileCount` = `scannedFiles.length`, not diagnostic-bearing-file count.                                                                                                                                                                                 | §4.1       |
| L-D10 | `FindingCode → (ruleId, category, defaultSeverity)` migration table matches `rules/index.ts`/`types.ts` exactly.                                                                                                                                                                                                                   | §3.6       |
| L-D11 | Freshness rules compare generated content modulo the generator-version stamp (#81); a version bump alone is never "stale", but formatting-only hand-edits remain detectable.                                                                                                                                                       | §3.2       |
| L-D12 | Diagnostics sort deterministically by `(file, line, col, ruleId)` before rendering (known partial-implementation gap noted at the definition site).                                                                                                                                                                                | §4.1       |
