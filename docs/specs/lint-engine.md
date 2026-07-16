# ai-plugin-marketplace — Harness-Config Lint Engine Specification

**Status:** Draft (design-authoritative; implementation PRs follow this document)
**Spec version:** 0.1.0
**Last updated:** 2026-07-16
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

### 1.2 What exists today (baseline, verified 2026-07-16)

- The only lint surface is `validate()` (`packages/core/src/pipeline/validate.ts`, orchestrated
  per `architecture.md` §10) plus the CLI's text renderer in `packages/cli/src/run.ts`.
- Diagnostics are `Finding` objects: two severities (`hard`/`soft`), a closed `FindingCode`
  enum, message strings with no line/column positions, no per-rule configuration, no
  machine-readable output.
- All schema validation is zod, private to core; no JSON Schemas are published.
- Discovery requires an aipm-authored repo (`aipm.config.ts` per plugin); foreign config cannot
  be linted at all.
- No ESLint integration exists for consumers (the repo's own `eslint.config.mjs` is dev-only).

### 1.3 Non-goals

- **No LSP / language server** in this spec's scope (the published JSON Schemas deliver most
  editor value via existing JSON/YAML language servers).
- **No auto-fix in v1** beyond the `fix` field being present in the diagnostic model (L-D2);
  fix application is follow-on work.
- **No normalization of user-authored semantics** — e.g. the agent-UX rules judge description
  *quality signals*, they do not rewrite descriptions.
- **No new authoring format.** The engine lints existing formats; it does not introduce one
  (architecture.md §14 holds).

---

## 2. The engine (`packages/core/src/lint/`)

### 2.1 Diagnostic model

> **L-D1 (normative).** The engine's unit of output is a `Diagnostic`:
>
> ```ts
> interface Diagnostic {
>   ruleId: string;              // e.g. 'correctness/broken-file-ref'
>   category: 'schema' | 'correctness' | 'security' | 'agent-ux' | 'portability';
>   severity: 'error' | 'warn' | 'info';
>   message: string;
>   file: string;                // repo-relative path
>   range?: Range;               // { start: {line, col}, end: {line, col} }, 1-indexed
>   docsUrl: string;             // generated per-rule docs page
>   hint?: string;
>   fix?: Fix;                   // reserved; not applied in v1
>   legacyCode?: FindingCode;    // present when the rule migrates an existing check
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

### 2.2 Position-aware document layer

> **L-D3 (normative).** All content parsing flows through a document layer that retains source
> positions: JSON via `jsonc-parser` (offset→line/col), YAML via the `yaml` package's CST,
> markdown frontmatter via offset-tracked extraction. Zod validation runs against the plain
> values, and zod issue `path`s are resolved back to document nodes to produce ranges. No rule
> re-parses files ad hoc.

This layer is the single largest enabler of "best available": every schema error, broken
reference, and quality warning lands on a clickable `file:line:col`.

### 2.3 Rules

> **L-D4 (normative).** A rule is a module implementing:
>
> ```ts
> interface Rule {
>   meta: {
>     id: string;                       // '<category>/<kebab-name>'
>     category: Diagnostic['category'];
>     defaultSeverity: 'error' | 'warn' | 'info' | 'off';
>     description: string;              // one-liner, feeds generated docs
>     appliesTo: DiscoveryMode[];       // which discovery modes run it (§2.4)
>   };
>   check(ctx: RuleContext): Diagnostic[] | Promise<Diagnostic[]>;
> }
> ```
>
> `RuleContext` exposes the parsed document set and workspace model read-only. Rules never do
> their own file discovery or parsing. Rule ids are additive public API (new rule = MINOR,
> removal/rename = MAJOR), mirroring the existing `FindingCode` policy.

### 2.4 Discovery modes (foreign config support)

> **L-D5 (normative).** The engine discovers lintable units via pluggable modes, auto-detected
> from the target path and forceable via `--as`:
>
> | Mode | Detection signal | Unit |
> |---|---|---|
> | `aipm-repo` | `aipm.config.ts` / `aipm.repo.ts` (existing discovery) | full repo, all checks |
> | `claude-plugin` | `.claude-plugin/plugin.json` | one plugin tree |
> | `open-plugin` | `.plugin/plugin.json` | one Open Plugins tree |
> | `skills-dir` | directory of `*/SKILL.md` (or a single `SKILL.md`) | skills only |
> | `claude-user-config` | `settings.json` + any of `skills/`, `agents/`, `commands/`, `hooks/` in a `.claude`-shaped dir | user/project config |
>
> Detection is ordered top-to-bottom; first match wins; ambiguity is an explicit diagnostic, not
> a guess. Cross-file semantic rules that require the aipm workspace model (freshness,
> mcp-key-sync, name-consistency, envelope adherence) declare `appliesTo: ['aipm-repo']` and are
> silently absent in foreign modes — foreign configs get every rule whose inputs exist.

### 2.5 Configuration and suppression

> **L-D6 (normative).** Rule configuration lives in a `lint` block of `aipm.config.ts` /
> `aipm.repo.ts`, or a standalone `aipm.lint.ts` for foreign-mode use: per-rule severity
> override or `'off'`, plus path ignore globs. Inline suppression is supported where the host
> format has comments — `# aipm-lint-disable-next-line <ruleId>` in YAML and
> `<!-- aipm-lint-disable-next-line <ruleId> -->` in markdown. JSON files have no comment
> channel; suppression there is config-file-only. Unknown rule ids in config or suppressions are
> themselves a `warn` diagnostic (typo protection).

---

## 3. Rules v1

### 3.1 `schema/*` — structural conformance

The existing zod schemas (per-target `schemas.ts`, config schemas in `config.ts`), re-emitted
through L-D3 so every issue has a range. Zod remains the sole authority (L-D8).

### 3.2 `correctness/*` — things that silently break at runtime

Migrations of every existing check (`envelope-adherence`, `name-consistency`, `mcp-key-sync`,
`freshness`, path safety, frontmatter parse, marketplace registration, root-artifact rules) plus
new rules:
- `correctness/broken-file-ref` — manifest and frontmatter references to files that don't exist.
- `correctness/unknown-hook-event` — event names outside the host's recognized set.
- `correctness/invalid-matcher` — hook matchers that are not valid regexes.
- `correctness/duplicate-component-name` — colliding skill/agent/command names within a unit.

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

---

## 4. Surfaces

### 4.1 CLI — `aipm lint`

`aipm lint [path] [--as <mode>] [--format text|json|sarif] [--rule <id>=<severity> ...]`

- `text` (default): grouped by file, `file:line:col ruleId severity message`, docs URL on
  verbose.
- `json`: the `Diagnostic[]` array plus a summary envelope.
- `sarif`: SARIF 2.1.0, one `rule` per rule id — direct GitHub code-scanning upload.
- Exit codes: `0` no `error`-severity diagnostics, `1` errors present, `2` usage error —
  congruent with `aipm validate` today.
- `aipm validate` is retained unchanged in behavior (L-D2) and documented as the CI
  build-contract profile; `aipm lint` is the superset linter.

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

---

## 6. Sequencing

Spec-first, then serially unblocked fleet issues:

1. **Engine core** — `Diagnostic`/`Rule`/document layer; migrate all existing validate checks as
   rules; `validate()` reimplemented over the engine with byte-alike output (L-D2 proven by the
   existing validate test suite passing unmodified).
2. **CLI `aipm lint`** — text/json/sarif, exit codes; SARIF output validated against the SARIF
   2.1.0 schema in tests.
3. **Foreign discovery modes** (L-D5) with fixture trees per mode.
4. **JSON Schema generation + publishing** (L-D8).
5. **ESLint plugin package.**
6. **Rule packs** — security, agent-ux, portability (one issue each; each rule lands with
   spec-derived positive and negative tests).
7. **Generated rule docs.**

Every issue's merge gate is the standing one: `pnpm run check` + dogfood `aipm validate` green,
plus a changeset.
