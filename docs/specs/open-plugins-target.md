# ai-plugin-marketplace — The `open-plugins` Target Specification

**Status:** Draft (design-authoritative; implementation PRs follow this document)
**Spec version:** 0.1.0
**Open Plugins spec version:** 1.0.0 ([open-plugins.com](https://open-plugins.com))
**Host behavior verified:** 2026-07-07 (Claude Code 2.1.202, Cursor current)
**Last updated:** 2026-07-07
**Scope:** Adds Open Plugins v1.0.0 as a 7th host target (`open-plugins`) to
`@ai-plugin-marketplace/core` and `@ai-plugin-marketplace/cli`. Companion to `architecture.md`
(§2 principles, §6 envelope, §8.1 public API, §12 seams) and `embedded-marketplaces-and-codex-target.md`
(the in-place registry-backed target pattern this target follows). Reconciles with the unmerged
`adapter-system.md` draft (§8 below).

> **Note to future readers.** This spec is design-authoritative documentation, per the repo's
> spec-first convention. It records not only what the `open-plugins` target does, but _why_ it is a
> target (not a unified manifest), which invariants must hold, and which host-behavior facts the
> design depends on — with the date each was verified. When the design evolves, update this
> document in the same change that moves the code. The environment-variable and registry-probe
> decisions (§3, §11) rest on host behavior observed on a specific date; re-verify before flipping
> them (§10).

---

## 1. Purpose and scope

### 1.1 What this target is

Open Plugins ([open-plugins.com](https://open-plugins.com), v1.0.0) is an **external, vendor-neutral
standard** for the on-disk shape of an AI-assistant plugin: a `.plugin/plugin.json` manifest,
conventional component directories (`commands/`, `agents/`, `skills/`, `rules/`, `hooks/`), and a
`marketplace.json` registry — designed so that multiple hosts can consume one plugin tree without a
per-vendor layout ([spec](https://open-plugins.com/plugin-builders/specification.md),
[marketplace](https://open-plugins.com/plugin-builders/marketplace.md)).

The `open-plugins` target makes the toolkit emit and validate the artifacts of that external
standard, exactly as it already does for `claude`, `cursor`, and `codex`. A plugin author who adds
`'open-plugins'` to their envelope gets an Open-Plugins-conformant `.plugin/plugin.json` and a
repo-root `marketplace.json`, generated from the same authored source that feeds every other target.

### 1.2 What this is _not_ — the P1/§14 reconciliation

Governing principle **P1** (`architecture.md` §2, "Per-target native authoring") makes each host a
first-class target with its full native feature set; non-goal **§14** ("A unified manifest format")
forbids the toolkit inventing a lowest-common-denominator authoring format.

**Targeting Open Plugins is P1-conformant, not a §14 violation.** The distinction is _authorship_
versus _emission_:

- §14 forbids the toolkit **inventing** a unified authoring surface that authors write _into_ and
  that the toolkit then fans out from. That is the "universal manifest" failure mode P1 rejects.
- Open Plugins is a **published external standard with its own conformance surface** that _some
  hosts consume directly_. Emitting to it is the same act as emitting a `gemini-extension.json` or a
  `.codex-plugin/plugin.json`: a target with a fixed external shape the toolkit projects onto. The
  toolkit does not ask authors to write "in Open Plugins format" instead of per-target formats — it
  adds one more target alongside the six that exist.

> **OP-D1 (normative).** `open-plugins` is a **host target**, not a unified authoring format. It
> participates in the support envelope (`architecture.md` §6) like any other target: opt-in per
> plugin, emitted only when declared, validated against its own external spec. It introduces **no**
> cross-target translation (P4, §7.3): its artifacts are projected from the shared authored source,
> never synthesized from another target's native manifest.

### 1.3 In scope

- Registering `open-plugins` as a 7th `TargetId` and wiring its per-target module (§9, §12.5 of
  `architecture.md`).
- The `.plugin/plugin.json` manifest schema and the toolkit's authoring profile for it (§4).
- The repo-root `marketplace.json` as a **4th generated registry** (§3).
- The validation contract mapping Open Plugins' normative MUSTs to `FindingCode`s (§6).
- Soft conformance advisories on the existing `claude`/`cursor`/`codex` targets (§7).
- The environment-variable policy for shared artifacts (§11).

### 1.4 Out of scope

- Rewriting shared artifacts (`.mcp.json`, `hooks/hooks.json`) to `${PLUGIN_ROOT}` — deferred with
  an explicit revisit trigger (§11).
- Per-host `SKILL.md` frontmatter rewriting or subagent adaptation — that is the unmerged
  `adapter-system.md` draft's concern (§8).
- A `dist/open-plugins/` bundle — `open-plugins` is an in-place target, never emitted-installed (§3).
- Publishing or hosting an Open Plugins registry (federation is `architecture.md` §15.3).

---

## 2. Normative summary of the external spec

Every claim below is a **normative** requirement of Open Plugins v1.0.0, cited to its source page.
These are the requirements §6 maps onto `FindingCode`s.

### 2.1 Manifest — `.plugin/plugin.json`

- The manifest is **OPTIONAL for consumption**: a directory with conventional component folders is a
  valid plugin with no manifest at all
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- When present, the only **required** field is `name`: 1–64 chars, lowercase alphanumeric plus
  hyphens and periods, alphanumeric start and end, no `--` and no `..`
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- Optional fields: `version` (semver), `description`, `author {name, email, url}`, `homepage`,
  `repository`, `license` (SPDX), `logo`, `keywords[]`
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- Component-path fields `commands` / `agents` / `skills` / `rules` / `hooks` / `mcpServers` /
  `lspServers` / `outputStyles` each accept `string | string[] | { paths, exclusive }`. **All paths
  MUST be `./`-relative with no parent traversal**
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- The metadata directory **MUST contain only `plugin.json`**
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- Tool-specific directories (`.claude-plugin/`, `.cursor-plugin/`) are **valid manifest locations**;
  a tool SHOULD prefer its own vendor directory, then fall back to `.plugin/plugin.json`
  ([plugin-builders](https://open-plugins.com/plugin-builders.md),
  [supported-agents](https://open-plugins.com/supported-agents.md)).

### 2.2 Default component locations

`commands/*.md`, `agents/*.md` (frontmatter `name` + `description`), `skills/<dir>/SKILL.md`,
`rules/*.mdc` (frontmatter `description` / `alwaysApply` / `globs`), `hooks/hooks.json`, `.mcp.json`,
`.lsp.json`. A root `SKILL.md` MAY define a single-skill plugin
([specification](https://open-plugins.com/plugin-builders/specification.md)).

### 2.3 Namespacing and expansion

- Components are namespaced `{plugin-name}:{component-name}`
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- Tools **MUST expand `${PLUGIN_ROOT}`** (or a vendor-prefixed equivalent) in paths
  ([specification](https://open-plugins.com/plugin-builders/specification.md)).
- Tools **MUST ignore unsupported component types** — forward compatibility is a host obligation
  ([agent-builders](https://open-plugins.com/agent-builders.md)).

### 2.4 Marketplace — `marketplace.json`

- Lookup order: (1) repo root, (2) `.plugin/marketplace.json`, (3) `.<tool>-plugin/marketplace.json`
  ([marketplace](https://open-plugins.com/plugin-builders/marketplace.md)).
- Required: `name` and `plugins[]` with **≥1 entry**. Each entry `{ name, source }` where `source`
  is `./`-relative, plus optional `description` / `version` / `author` / `license` / `keywords`
  overrides; optional top-level `owner {name, email, url}` and `metadata.pluginRoot` (default `"."`)
  ([marketplace](https://open-plugins.com/plugin-builders/marketplace.md)).
- Fallback discovery when no `marketplace.json` exists: root-is-plugin, then subdirectories ≤2 deep
  ([marketplace](https://open-plugins.com/plugin-builders/marketplace.md)).

### 2.5 What the spec does _not_ provide

- **No official JSON Schema is published.** The referenced `plugin-ref` validator is **not on npm**
  (verified 2026-07-07). Consequence: the toolkit's `open-plugins` Zod schema is the authority; it is
  written directly from the prose spec (§4), and its tests assert against the spec text, not against
  a downloaded schema.

---

## 3. Consumption class and registry topology

### 3.1 In-place, registry-backed — like Claude/Cursor/Codex

Open Plugins hosts install a plugin **in place** from a repo the registry points at; there is no
vendor-owned bundle to materialize. So `open-plugins` joins the **in-place registry-backed** class
(`claude`, `cursor`, `codex`) and explicitly **not** the emitted-installed single-artifact class
(`gemini`, `kiro`).

> **OP-D2 (normative).** `open-plugins` produces **no `dist/` bundle** and runs **no mechanical
> transform** (P4). It emits (a) a per-plugin `.plugin/plugin.json` in the plugin directory and (b) a
> repo-root `marketplace.json`. The single-artifact-host machinery (`SINGLE_ARTIFACT_HOSTS =
['gemini', 'kiro']`, `packages/core/src/pipeline/build.ts:376`) is **untouched** — `open-plugins`
> is never added to it.

### 3.2 Root `marketplace.json` — the 4th generated registry

Today the toolkit generates three repo-root registries, keyed by target in `REGISTRY_REL_PATHS`
(`packages/core/src/pipeline/build.ts:220`): `claude → .claude-plugin/marketplace.json`,
`cursor → .cursor-plugin/marketplace.json`, `codex → .agents/plugins/marketplace.json`. Each is a
whole-file regenerate-and-byte-compare artifact (`RegistryArtifact`, `build.ts:210`) shared by
`runBuild` and the freshness oracle.

> **OP-D3 (normative).** `open-plugins` adds a **4th** entry to `REGISTRY_REL_PATHS`:
> `open-plugins → marketplace.json` at the **repo root** (Open Plugins lookup order position 1, §2.4).
> It follows the existing `computeRegistryArtifacts` path (`build.ts:312`): one registry file is
> emitted iff at least one plugin's envelope includes `open-plugins`, listing exactly those plugins.
> `managedRegistryPaths` (`build.ts:233`) gains this path so an orphaned root `marketplace.json` is
> removed and flagged like any other stale registry.

**Registry entry shape.** Open Plugins entries are string-source `{ name, source }` (§2.4) — the same
shape Claude/Cursor already use (`buildStringSourceRegistry`, `build.ts:254`), so no new entry
builder is required. The registry carries the workspace `name` (and optional `owner` / `metadata`)
exactly as the Claude/Cursor registries do.

> **OP-D4 (normative).** `metadata.pluginRoot` stays at its default `"."`, and each entry's `source`
> is the **full** repo-root-relative path (`./plugins/<name>`, or `./agent-plugins/<name>` under an
> embedded/relocated `pluginsRoot`). The alternative — set `pluginRoot` to the plugins root and use
> bare plugin names — is rejected: keeping `source` derivation identical to Claude/Cursor
> (`marketplaceSource`, `scaffold.ts:182`; `collectRegistryPlugins`, `build.ts:346`) means **one**
> source-of-truth for the source string and byte-stable freshness across all four registries.

### 3.3 Foreign-root-file collision guard

A repo-root `marketplace.json` is a new repo-root path the toolkit writes. In the dedicated-marketplace
template repo it is **zero-conflict today** (nothing else owns a root `marketplace.json` —
empirical §5.1). In an embedded marketplace (a software repo that also hosts plugins,
`embedded-marketplaces-and-codex-target.md`), the host could conceivably already own that path.

> **OP-D5 (normative).** The root `marketplace.json` is protected by the **existing** generated-root
> collision guard: it is tracked in the `.aipm/generated-root.json` sidecar
> (`ROOT_MANIFEST_REL`, `build.ts:382`) and a pre-existing, untracked root `marketplace.json` raises
> a **hard `root-artifact-collision`** finding (`detectRootCollisions`, `build.ts:553`) rather than
> being clobbered. This reuses the guard already protecting the `gemini`/`kiro` root artifacts; no
> new mechanism is invented.

> **Discovered deviation to flag (non-blocking).** Today the sidecar/collision guard
> (`computeRootArtifacts` → `detectRootCollisions`) tracks only the **single-artifact-host** root
> files, while the three registries use a separate `managedRegistryPaths` orphan-removal path and are
> **not** collision-guarded against foreign files. Extending collision protection to the root
> `marketplace.json` therefore requires either (a) routing the root registry through the
> generated-root sidecar tracking, or (b) adding a registry-specific collision check. The plan
> assumed the sidecar already covers it; implementation must close this seam. Option (a) is preferred
> — it unifies "repo-root files the toolkit owns" under one tracked set. See verify-task VT-4 (§10).

---

## 4. Authoring profile (stricter than the external spec)

Open Plugins makes the manifest optional and its grammar permissive. The toolkit deliberately
authors to a **stricter** profile, because the toolkit needs a stable anchor for name-consistency,
envelope adherence, and scaffolding.

### 4.1 The manifest is REQUIRED by the toolkit

> **OP-D6 (normative).** When `open-plugins` is in a plugin's envelope, the toolkit **requires**
> `.plugin/plugin.json` (added to `TARGET_MIN_REQUIRED`, `packages/core/src/pipeline/validate.ts:85`,
> and to `TARGET_OWNED_ARTIFACTS`, `validate.ts:58`). Rationale: the manifest `name` is the anchor
> the toolkit uses for cross-manifest name-consistency (§6), envelope adherence, and the
> `metadata-dir-isolation` check. A manifest-less plugin is spec-valid for _consumption_ but gives
> the toolkit nothing to validate against — so authoring requires it even though the spec does not.
> (This mirrors how the spec permits a bare component tree but the toolkit still requires each native
> target's manifest.)

### 4.2 Two grammars: scaffold slug ⊂ spec grammar

There are two name grammars in play, and they are intentionally different:

| Grammar                                                    | Where                                                                                              | Pattern                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Toolkit scaffold slug** (what the CLI generates)         | `validatePluginName`, `scaffold.ts:73`; every native manifest schema                               | `^[a-z][a-z0-9-]*$`, no `--`, no trailing `-`                                  |
| **Open Plugins `name` grammar** (what a manifest may hold) | `open-plugins` Zod schema (new); [spec](https://open-plugins.com/plugin-builders/specification.md) | 1–64, lowercase alnum + `-` and `.`, alnum start **and end**, no `--`, no `..` |

> **OP-D7 (normative).** The scaffold slug grammar is a **strict subset** of the Open Plugins name
> grammar (it forbids periods and requires a letter start; the spec permits a digit start and
> interior periods). Therefore: (a) every name the toolkit scaffolds is automatically
> Open-Plugins-valid; (b) the `open-plugins` Zod schema accepts the **full** spec grammar so a
> hand-authored `.plugin/plugin.json` using a period or digit-start name still validates. The schema
> does not narrow to the scaffold slug — that would reject spec-legal manifests the toolkit did not
> generate. Cursor's installed runtime regex `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` equals the spec
> grammar (empirical §5.2), confirming the spec grammar is the right validation width.

### 4.3 Manifest field mapping

The `.plugin/plugin.json` the scaffolder emits mirrors the Codex/Cursor scaffold (`scaffold.ts` in
each target module): `{ schemaVersion, name, version, description? }` at minimum, with the
component-path fields (`commands`/`agents`/`skills`/`rules`/`hooks`/`mcpServers`/`lspServers`/
`outputStyles`) accepted as `string | string[] | { paths, exclusive }` and constrained to
`./`-relative, no-`..` paths. `schemaVersion` is carried but not validated (`architecture.md` §9.4,
§12.2), consistent with every other target manifest.

---

## 5. Capability-coverage matrix — `open-plugins` vs the native targets

**When should an author pick `open-plugins`, and when a native target?** The matrix below is the
guidance. It is grounded in the **actual shipped target code** (`packages/core/src/targets/*/schemas.ts`),
not the external spec's aspiration — several plan entries were corrected against the code (flagged
inline).

| Native capability                       | `open-plugins` substitute?          | Grounding / correction                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude full hook event set**          | **Partial — keep `claude`**         | Open Plugins fixes the hook file _location_ (`hooks/hooks.json`, §2.2), **not** the event vocabulary. Claude's full `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`/… set (`architecture.md` P1) is not part of the Open Plugins normative surface. Hook-heavy plugins keep the `claude` target.                                      |
| **Codex registry policy + `interface`** | **No — keep `codex`**               | The shipped `codex` registry carries `policy.installation`/`policy.authentication` and `category` (`build.ts:281` `buildCodexRegistry`; `scaffold.ts:159` `CodexEntry`) and the manifest carries `interface`/`apps` (`targets/codex/schemas.ts:146,139`). Open Plugins' `marketplace.json` has no equivalent.                              |
| **Codex TOML subagents / `AGENTS.md`**  | **No (and not shipped yet either)** | **Correction:** the shipped `codex` target emits **only** `.codex-plugin/plugin.json` (`targets/codex/scaffold.ts:51`). TOML subagents and `AGENTS.md` are described in the **unmerged** `adapter-system.md` draft (§4.5), not in shipped code. So this row is a _future_ Codex capability, not a current gap Open Plugins fails to cover. |
| **Cursor `rules/*.mdc`**                | **Yes (host support is partial)**   | `rules/*.mdc` with `description`/`alwaysApply`/`globs` frontmatter is native to both Cursor (`cursorRuleFrontmatterSchema`, `targets/cursor/schemas.ts:135`) and Open Plugins' default locations (§2.2). Rule-only plugins port cleanly; whether a given host _consumes_ Open Plugins rules is host-dependent (§2.3 MUST-ignore).          |
| **Gemini / Kiro bundles**               | **No — keep `gemini`/`kiro`**       | These are emitted-installed single-artifact hosts (`SINGLE_ARTIFACT_HOSTS`, `build.ts:376`) with wholly toolkit-owned `dist/` bundles. Open Plugins is in-place only (OP-D2); it cannot represent a bundle host.                                                                                                                           |
| **`outputStyles` / `lspServers`**       | **In spec; host-side degradation**  | Both are Open Plugins component-path fields (§2.1) and appear in the Cursor manifest schema (`outputStyles`, `lspServers`, `targets/cursor/schemas.ts:87,95`). A host that does not support them MUST ignore them (§2.3) — graceful degradation, not an error.                                                                             |
| **Vercel skills-only**                  | **Subset**                          | The `vercel` target is `SKILL.md`-only (`vercelSkillFrontmatterSchema`, `targets/vercel/schemas.ts:49`; no `plugin.json`). Open Plugins' `skills/<dir>/SKILL.md` (§2.2) is a superset surface, so a Vercel skill is a valid Open Plugins component but Open Plugins carries more than Vercel consumes.                                     |

> **OP-D8 (normative).** `open-plugins` **does not deprecate** any native target. It is additive: it
> serves hosts that consume the Open Plugins layout, while hook-heavy (Claude), policy-rich (Codex),
> and bundle (Gemini/Kiro) plugins keep their native targets. Authors declare both where both apply.

---

## 6. Validation contract

Each Open Plugins normative MUST (§2) maps to a `FindingCode` and severity. Findings that fire **only
inside the `open-plugins` target** (i.e. when `open-plugins` is in the envelope) are hard; the same
rules applied to _other_ targets are soft advisories (§7).

| Open Plugins requirement (§2)                                                | `FindingCode`                | Severity (in `open-plugins` target) | Reuse / new |
| ---------------------------------------------------------------------------- | ---------------------------- | ----------------------------------- | ----------- |
| Manifest `name` present and grammar-valid (§2.1)                             | `schema-invalid`             | hard                                | reuse       |
| Component paths `./`-relative, no `..` (§2.1)                                | `schema-invalid`             | hard                                | reuse       |
| Metadata dir contains **only** `plugin.json` (§2.1)                          | **`metadata-dir-isolation`** | hard                                | **new**     |
| `marketplace.json` has `name` + `plugins[]` ≥ 1 (§2.4)                       | `marketplace-registration`   | hard                                | reuse       |
| Marketplace entry `source` `./`-relative, points at the plugin (§2.4)        | `marketplace-registration`   | hard                                | reuse       |
| Repo-root `marketplace.json` must not clobber foreign file (§3.3)            | `root-artifact-collision`    | hard                                | reuse       |
| `name` consistent across `.plugin/plugin.json` and vendor manifests          | `name-consistency`           | hard                                | reuse       |
| Generated registry/manifest is fresh (`architecture.md` §10.5)               | `freshness`                  | hard in CI / soft local             | reuse       |
| No artifact for `open-plugins` outside the envelope (`architecture.md` §6.2) | `envelope-adherence`         | hard                                | reuse       |

### 6.1 The one new finding code: `metadata-dir-isolation`

> **OP-D9 (normative).** Add `metadata-dir-isolation` to the `FindingCode` union
> (`packages/core/src/pipeline/types.ts:145`). It is **hard**, and fires only for the `open-plugins`
> target, when the plugin's metadata directory (`.plugin/`) contains any entry other than
> `plugin.json` (§2.1). Rationale: this is the one Open Plugins MUST with no existing analog — the
> native targets' vendor dirs (`.claude-plugin/`, `.cursor-plugin/`) are allowed to hold
> `marketplace.json` too, so a generic "vendor dir is clean" rule would wrongly fail them. The check
> is scoped to `.plugin/` specifically.

### 6.2 Reused codes — no semantic overload

Every other requirement reuses an existing code with its existing meaning: `schema-invalid` for Zod
failures (the new `open-plugins` schema plugs into `TARGET_VALIDATORS`, `validate.ts:935`),
`marketplace-registration` for the root-registry projection (extend `MARKETPLACE_REGISTRY_CHECKS`,
`validate.ts:749`, with an `open-plugins` descriptor using `extractStringSource`),
`root-artifact-collision` for the root-file guard, `name-consistency` and `envelope-adherence` from
the cross-target validators (`validate.ts:913`). This honors the api-semantics rule: a code means one
thing across the codebase; we do not overload `marketplace-registration` to also mean "metadata dir
dirty."

---

## 7. Conformance-overlap advisories on existing targets

Open Plugins' rules overlap the existing targets: a `claude` or `cursor` plugin is often _nearly_
Open-Plugins-conformant already. Surfacing that cheaply — without ever failing a native target —
helps authors discover they could add `open-plugins`.

> **OP-D10 (normative).** Add a **soft** `open-plugins-conformance` `FindingCode`. It is emitted on
> `claude` / `cursor` / `codex` plugins (whether or not `open-plugins` is in the envelope) for:
>
> - a component/manifest path that is **not** `./`-prefixed (an Open Plugins MUST, §2.1) — note commit
>   `0bfc191` already made the Claude/Cursor `mcpServers` field accept a `./`-prefixed path, so this
>   advisory is consistent with the direction the schemas already moved;
> - plugin-level metadata-dir isolation (a non-`plugin.json` file in what would be the `.plugin/` dir);
> - a plugin `name` that is Open-Plugins-legal-but-not-scaffold-slug, or vice versa (grammar drift, §4.2).
>
> These are **advisories only**: `open-plugins-conformance` is **always soft** and never flips
> `ValidationResult.passed` (`architecture.md` §10.2). The identical rules are applied **hard** only
> _inside_ the `open-plugins` target (§6). This asymmetry is deliberate: an advisory must never break
> a native target that has no obligation to Open Plugins.

**Why a distinct code and not `schema-invalid`.** A `claude` plugin with a non-`./` path is
**valid Claude** — it violates no Claude rule. Reporting it as `schema-invalid` would falsely assert
the Claude manifest is broken. `open-plugins-conformance` says precisely what it is: "this is fine
for your declared targets, and here is what Open Plugins would additionally want." (api-semantics:
name by meaning, not by the nearest already-wired mechanism.)

---

## 8. Reconciliation with the unmerged adapter-system draft

`adapter-system.md` (v0.3.0, **unmerged draft** — do not treat as shipped) defines a per-target
**adapter layer** for shared authored content (skills, agents, hooks). It and this spec are
complementary: this spec adds a _host target_; the adapter draft adds _content adaptation_ that any
target — including `open-plugins` — can consume. Three non-blocking proposals for when both land:

1. **§8 future-envelope candidates via `open-plugins`.** The adapter draft's §8 lists **CodeBuddy**
   and **OpenCode** as future-envelope candidates worth verifying. Both are plausible Open Plugins
   consumers; the cheapest way to reach them is the `open-plugins` target, not a bespoke per-host
   target each. Propose: when those hosts are evaluated, first check whether they consume the Open
   Plugins layout and, if so, route them through `open-plugins` rather than adding `codebuddy` /
   `opencode` `TargetId`s.

2. **§2.1 native-manifest table gains a `.plugin/plugin.json` row.** The draft's §2.1 "what adapters
   may and may not touch" table enumerates the per-target native manifests as hand-authored,
   never-synthesized (P1). Add a row: `.plugin/plugin.json` (Open Plugins) — **hand-authored,
   toolkit-required (OP-D6), never synthesized from another target's manifest**. This keeps the
   adapter layer's "no target→target translation" invariant explicit for the new manifest.

3. **§4.2 hooks tiering applies per consuming host.** The draft tiers hooks into observer vs
   controller and notes the handler contract diverges by host. Open Plugins standardizes only the
   hook file _location_ (`hooks/hooks.json`), **not** the handler contract — so the draft's
   observer/controller tiering still applies to whichever concrete host consumes an Open Plugins
   plugin's hooks. The `open-plugins` target does not resolve hook-contract divergence; it inherits
   whatever the consuming host requires.

> These are proposals to fold into `adapter-system.md` when it is next revised. This spec does **not**
> edit that draft. Landing `open-plugins` does not depend on the adapter layer, and vice versa.

---

## 9. Migration and versioning impact

### 9.1 Semver — additive, therefore MINOR

Adding a `TargetId` and adding `FindingCode`s are both **additive** changes. Per `architecture.md`
§9.2 ("New target added → Minor") and the additive-`FindingCode` contract (`types.ts:124`,
"new codes arrive in toolkit MINOR releases"):

> **OP-D11 (normative).** Registering `open-plugins` and adding the `metadata-dir-isolation` and
> `open-plugins-conformance` codes is a **MINOR** release of `@ai-plugin-marketplace/core` and
> `@ai-plugin-marketplace/cli` (released in lockstep, `architecture.md` §9.1). No existing plugin
> manifest changes; no `FindingCode` is removed or renamed (which would be MAJOR). A changeset for
> both packages accompanies the implementation (per the umbrella/changeset rules).

### 9.2 Default scaffold envelope

`ScaffoldOptions.targets` defaults to **all known targets** (`types.ts:185`,
"Defaults to all known targets"). Once `open-plugins` is in `TARGET_IDS` (`types.ts:33`), a default
`aipm scaffold` will therefore emit `.plugin/plugin.json` for every new plugin and generate the
repo-root `marketplace.json`.

> **OP-D12 (normative).** `open-plugins` **is** included in the default scaffold envelope (forward-
> looking, additive, zero-conflict today per §5.1). This means every freshly scaffolded plugin is
> Open-Plugins-conformant out of the box.
>
> **Open decision to surface (OQ-3, §10.2):** whether default-on is desirable given that it adds a repo-root
> `marketplace.json` to every new repo. The alternative — ship `open-plugins` known-but-not-default,
> opt-in via `aipm add-target <plugin> open-plugins` — keeps new repos minimal until the author opts
> in. Recommendation: **default-on**, because the root `marketplace.json` is zero-conflict today and
> the whole point is to make Open Plugins the low-friction cross-host path; but this is a maintainer
> call, tracked as OQ-3.

---

## 10. Verify-tasks and open questions

### 10.1 Verify-tasks (resolve before / while implementing)

- **VT-1 — Live Claude Code dogfood install.** With Claude Code 2.1.202, install a repo that has a
  repo-root `marketplace.json` (Open Plugins position 1) and confirm the behavior recorded in §5.1:
  Claude Code resolves from `.claude-plugin/marketplace.json` and does **not** probe the root
  `marketplace.json` or `.plugin/`. This confirms the root registry is forward-looking and
  zero-conflict (OP-D3). Re-run whenever Claude Code's marketplace resolver version changes.
- **VT-2 — Re-check OpenCode / Copilot / CodeBuddy when accessible.** These were not directly
  inspectable on 2026-07-07. When available, verify whether each consumes the Open Plugins layout (and
  which lookup position) before treating `open-plugins` as their delivery path (§8 proposal 1).
- **VT-3 — Recurring host-behavior re-verification.** The env-var (§11) and registry-probe (§3, §5)
  decisions rest on host binaries observed on 2026-07-07. Re-verify against the current Claude Code
  and Cursor builds **before** flipping any env-var or registry decision. Treat the "Host behavior
  verified" date in the header as the freshness stamp.
- **VT-4 — Close the root-registry collision seam.** Confirm (and implement, §3.3) that the root
  `marketplace.json` is covered by the generated-root sidecar tracking so `root-artifact-collision`
  actually protects it — today the sidecar tracks only single-artifact-host files.

### 10.2 Open questions

- **OQ-1 — No official JSON Schema.** Open Plugins publishes no schema and the `plugin-ref` validator
  is not on npm (§2.5). The toolkit's Zod schema is the sole authority; if an official schema later
  ships, reconcile the two (and add a `@see` to it in the schema tests).
- **OQ-2 — Spec maturity.** Open Plugins v1.0.0 is days old; its adoption claims appear overstated
  and current hosts empirically ignore its root-`marketplace.json` and `.plugin/` probes (§5). Treat
  the target as forward-looking until a host is verified to consume it (VT-1, VT-2).
- **OQ-3 — Default-on scaffold envelope.** Whether `open-plugins` belongs in the _default_ scaffold
  set or should be opt-in (§9.2, OP-D12). Maintainer decision.
- **OQ-4 — `.plugin/` + vendor-dir coexistence.** Open Plugins allows a manifest in both `.plugin/`
  and a vendor dir (vendor wins, §2.1); current hosts ignore `.plugin/` entirely (§5). The toolkit
  mitigates drift with cross-manifest name-consistency (§6), but the deeper question — should the
  toolkit emit `.plugin/plugin.json` _and_ the vendor manifests, or treat them as one logical
  manifest — stays open until a host actually reads both.

---

## 11. Environment-variable policy

Open Plugins mandates that tools expand `${PLUGIN_ROOT}` (§2.3). But the empirical host survey shows
no current host expands that variable:

- Claude Code 2.1.202 exposes only `${CLAUDE_PLUGIN_ROOT}` (+ `CLAUDE_PLUGIN_DATA`); no `${PLUGIN_ROOT}`
  (§5.1).
- Cursor sets **both** `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` to the plugin dir; no
  `${PLUGIN_ROOT}` (§5.2).

So `${CLAUDE_PLUGIN_ROOT}` is the **de-facto interop variable** — Cursor aliases it, and it is the
only root variable a shipped host actually expands.

> **OP-D13 (normative).** **Shared artifacts keep `${CLAUDE_PLUGIN_ROOT}`.** The `.mcp.json` and
> `hooks/hooks.json` that Claude/Cursor/Codex share (`SHARED_ARTIFACTS`, `validate.ts:76`) continue to
> use `${CLAUDE_PLUGIN_ROOT}`. The `open-plugins` target does **not** rewrite these to
> `${PLUGIN_ROOT}`. Rewriting to the spec-mandated variable today would break every current host,
> which expands `${CLAUDE_PLUGIN_ROOT}` and ignores `${PLUGIN_ROOT}` — a spec-conformant rewrite that
> is empirically non-functional. Emitting a distinct `${PLUGIN_ROOT}`-based copy is also rejected: it
> duplicates shared artifacts and reintroduces the per-target divergence the shared-artifact design
> removed.
>
> **Revisit trigger.** Flip this decision when a host ships `${PLUGIN_ROOT}` expansion (re-verify via
> VT-3). At that point, evaluate emitting `${PLUGIN_ROOT}` for the `open-plugins` target's own shared
> artifacts, or a host-detected alias map. Until then, `${CLAUDE_PLUGIN_ROOT}` is correct precisely
> because it is what runs.

---

## Appendix A — Empirical host findings (verified 2026-07-07)

Recorded here as the grounded basis for OP-D3, OP-D5, OP-D13, and the verify-tasks. Method: binary /
installed-bundle inspection of the named host versions.

### A.1 Claude Code 2.1.202 (binary inspection)

- Marketplace resolution **defaults to `.claude-plugin/marketplace.json`** for github / git /
  directory sources (an explicit path override is the only way to point elsewhere).
- **No probe** of a repo-root `marketplace.json` and **no probe** of `.plugin/`.
- Environment variables exposed: `${CLAUDE_PLUGIN_ROOT}` and `CLAUDE_PLUGIN_DATA` only. **No**
  `${PLUGIN_ROOT}`.

### A.2 Cursor (installed app bundle)

- Exactly two plugin-path literals: `[".cursor-plugin/marketplace.json", ".claude-plugin/marketplace.json"]`.
- Sets **both** `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` to the plugin directory. **No**
  `.plugin/`, **no** `${PLUGIN_ROOT}`.
- Name regex `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` — **equal to** the Open Plugins name grammar (§4.2).

### A.3 Consequence decisions

- **(a) Root `marketplace.json` is forward-looking, zero-conflict today.** No current host reads it,
  and nothing else occupies the repo-root path in the dedicated template. Vendor registries
  (`.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/`) stay load-bearing (OP-D3).
- **(b) `.plugin/` + vendor-dir coexistence is spec-defined (vendor wins) and empirically ignored by
  current hosts** — mitigate with cross-manifest name-consistency (§6, OQ-4).
- **(c) Shared artifacts keep `${CLAUDE_PLUGIN_ROOT}`** — the de-facto interop variable Cursor
  aliases; the `open-plugins` target does not rewrite to `${PLUGIN_ROOT}` (OP-D13); revisit when a
  host ships `${PLUGIN_ROOT}` expansion.

---

## Appendix B — Touch points to register the 7th target

Grounded in the current code; mirrors the codex registration recipe in
`embedded-marketplaces-and-codex-target.md`. `open-plugins` is already **not** present in these, so
each is a net addition:

- `TargetId` union + `TARGET_IDS` tuple + `_targetIdsAreExhaustive` guard
  (`packages/core/src/pipeline/types.ts:16,33,54`).
- New per-target module `packages/core/src/targets/open-plugins/{schemas,scaffold,validate}.ts`
  (`architecture.md` §12.5 layout; **no** `transform.ts` / `bundle.ts` — in-place, no transform).
- `TARGET_OWNED_ARTIFACTS` + `TARGET_MIN_REQUIRED` (`validate.ts:58,85`): `.plugin/plugin.json`.
- `SHARED_ARTIFACTS` (`validate.ts:76`): add `open-plugins` to the `.mcp.json` `anyOf`.
- `TARGET_VALIDATORS` (`validate.ts:935`) + `TARGET_SCAFFOLDERS` (`scaffold.ts:48`).
- `MARKETPLACE_REGISTRY_CHECKS` (`validate.ts:749`) + `MARKETPLACE_REGISTRIES` (`scaffold.ts:197`) +
  `REGISTRY_REL_PATHS` (`build.ts:220`): `open-plugins → marketplace.json` at repo root, string-source.
- `FindingCode` union (`types.ts:145`): add `metadata-dir-isolation`, `open-plugins-conformance`.
- Extend the all-targets enumerations in tests/fixtures (the target scaffold/validate suites already
  iterate `TARGET_IDS`).

---

## Sources

**Open Plugins v1.0.0** — [index](https://open-plugins.com/index.md) ·
[plugin-builders](https://open-plugins.com/plugin-builders.md) ·
[specification](https://open-plugins.com/plugin-builders/specification.md) ·
[marketplace](https://open-plugins.com/plugin-builders/marketplace.md) ·
[agent-builders](https://open-plugins.com/agent-builders.md) ·
[supported-agents](https://open-plugins.com/supported-agents.md)

**Companion specs** — `docs/specs/architecture.md` (P1, P4, §7.3, §8.1, §9, §10, §12.2, §12.5, §14) ·
`docs/specs/embedded-marketplaces-and-codex-target.md` (in-place registry-backed target pattern) ·
`docs/specs/adapter-system.md` (unmerged draft — §8 reconciliation)
