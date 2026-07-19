# ai-plugin-marketplace — Architecture Specification

**Status:** Draft
**Spec version:** 0.4.3
**Supersedes:** 0.4.2 (reintroduced `'shared'` to `GeneratedFile.target`)
**Last updated:** 2026-07-18
**Scope:** Umbrella architecture for the `ai-plugin-marketplace/template` and `ai-plugin-marketplace/tools` repositories and the `@ai-plugin-marketplace/*` npm packages.

> **Note to future readers.** This spec is durable documentation. It describes not only what the system does but _why_ each decision exists, which invariants must hold, and which capabilities are deferred with what hooks reserved so they can be added later without breaking changes. When the design evolves, update this document in the same change that moves the code.

> **What changed from 0.4.2 → 0.4.3.** Toolkit-generated artifacts now carry a generator-version stamp (`_generated.version` / `# version:` line), and `aipm build` enforces a downgrade guard (§4.3.1): a build whose installed `@ai-plugin-marketplace/core` is older than the version that produced a committed artifact refuses (or `--force-downgrade`) rather than silently reverting the file to the older generator's output. Freshness (§10.5) compares modulo the stamp. See Appendix B, 0.4.3.

---

## 1. Purpose and scope

### 1.1 What this system is

`ai-plugin-marketplace` is a toolchain and template for authoring AI coding-assistant plugins that ship to multiple host platforms — today Claude Code, Cursor, Gemini CLI, Kiro, and Vercel Skills CLI; tomorrow Codex, Windsurf, and others to be named. The system has two artifacts:

- **`ai-plugin-marketplace/template`** — a GitHub template repository. A plugin author forks it (via GitHub's "Use this template") and authors plugins inside. Thin by design: plugin source content and a dependency on the toolkit, nothing more.
- **`ai-plugin-marketplace/tools`** — a pnpm monorepo publishing the `@ai-plugin-marketplace/*` npm packages. These encode the validation rules, build pipelines, and schema contracts that the template consumes.

### 1.2 What this release delivers

**The structural win.** Before this reorganization, the template repo contained its own copy of validation, scaffolding, and build logic. Authors who cloned it were frozen at the scripts' state at clone time. Extracting the logic into versioned npm packages means authors upgrade via `pnpm up` and receive new capabilities without touching plugin sources.

**Two genuinely new capabilities on top of the port.** v0.1.0 is not a bare refactor — it introduces:

- **Explicit support envelope** (§6) — plugins declare which targets they support. The toolkit validates that every authored artifact corresponds to a declared target, and refuses to emit output for undeclared targets. This replaces the current "if you wrote a Gemini manifest, you have Gemini support" inference with intentional opt-in.
- **Compatibility-assist tooling** — `aipm check-support` diagnoses which targets a plugin could plausibly add, and `aipm add-target` scaffolds the skeleton files. This is the first toolkit affordance specifically aimed at helping authors expand their plugin's compatibility envelope without the toolkit doing automatic adaptation behind their backs.

### 1.3 Scope of this spec version

This spec covers the **initial shipping scope** — `@ai-plugin-marketplace/*@0.1.0` and the template at cutover. Richer authoring (TSX + JSX host components) and schema-migration infrastructure (migrex) are deliberately deferred.

### 1.4 In scope

- Package boundaries: `@ai-plugin-marketplace/core` + `@ai-plugin-marketplace/cli`
- Plugin source layout (raw-file authoring)
- Support envelope declaration and compatibility-assist tooling
- Mechanical transformations inside per-target build steps
- Per-target schema shape with a reserved version field
- Validation rules and failure semantics
- Template-to-toolkit dependency contract
- Bootstrap plan from the current single-repo layout
- Five forward-compatibility seams for future TSX, migrations, per-target packages, and third-party adapters

### 1.5 Out of scope

- TSX / JSX authoring mode (deferred; seam in §12.3)
- Schema migration infrastructure (deferred; seam in §12.2)
- Per-target package split (deferred; seam in §12.4)
- Public third-party target-adapter interface (deferred; seam in §12.5)
- Individual plugin content
- Host-platform documentation and runtime behavior
- Marketplace federation and trust model (future spec)

---

## 2. Governing principles

These are the load-bearing decisions. Principles marked **[Active]** are implemented in v0.1.0. Principles marked **[Future]** are committed direction, with seams in §12 making them cheap to add later.

### P1 — Per-target native authoring [Active]

Each host platform is a first-class target with its full native feature set exposed. Claude Code hooks use the real Claude hook schema (`PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit` with tool matchers). Cursor rules use `.mdc`. Kiro uses `POWER.md` plus `steering/`. Gemini CLI uses `gemini-extension.json` with snake_case tool names.

**Why this matters.** The platforms genuinely differ. Claude's hook model has no lossless translation to Kiro's. Any "universal" manifest either caps everyone at the lowest common denominator or accumulates so many per-target escape hatches that the unified format becomes ceremony around the original per-target manifests.

### P2 — Author-declared support envelope [Active]

Each plugin declares its supported targets in `aipm.config.ts`. The toolkit emits artifacts only for declared targets and validates that every authored artifact corresponds to a declared target. There is **no automatic adaptation** from one target to another.

**Why this matters.** Automatic adaptation is the same failure mode as a universal manifest in different clothing. It produces lossy or wrong output in the places authors care most about precision. The toolkit invests instead in _compatibility-assist tooling_ (§6.4) that surfaces options explicitly.

### P3 — Template consumes toolkit as an npm dependency [Active]

The template depends on `@ai-plugin-marketplace/cli` via semver. Upgrades flow through `pnpm up`. The template holds no toolkit source and no vendored logic. _This is the whole point of the reorganization._

### P4 — Mechanical transformations stay within a single target's build step [Active]

Deterministic, lookup-table-driven, lossless transformations (tool-name mappings, YAML→JSON, bundle assembly) live inside that target's build code. They never cross target boundaries. Cross-target translation (a Claude hook → a Kiro hook) is forbidden.

### P5 — Both authored sources and generated outputs are committed [Active]

Authors commit both hand-authored files and toolkit-generated files (`hooks/claude.json` from `hooks/claude.yaml`, `dist/gemini/*`, `dist/kiro/*`). CI enforces a freshness check (§10.5). Keeps plugins browsable on GitHub without running the toolkit; keeps PR diffs honest.

### P6 — TypeScript end-to-end [Active]

Zod schemas. TypeScript toolkit. TypeScript author config (`aipm.config.ts`). No YAML-based manifest, no JSON-Schema-driven config, no custom DSL.

### P7 — Versioned schemas with bidirectional migrations [Future, seam reserved]

Every target manifest schema will eventually be versioned and registered in a migrex migration graph. v0.1.0 ships with schemas in their first stable shape and no migration infrastructure. The `schemaVersion` field is reserved as the future migration-graph entry point — see §12.2.

### P8 — Shared content via typed TSX composition [Future, seams reserved]

A future release will introduce TSX authoring with typed host components rendering into per-target artifacts. Reserved filename conventions (§12.3) and the named transform step in the build pipeline (§12.4) make this an additive extension.

---

## 3. Repository topology

### 3.1 Two repositories, one system

```
github.com/ai-plugin-marketplace/
├── template/       # GitHub template repo — plugin authors fork this
└── tools/          # pnpm monorepo — publishes @ai-plugin-marketplace/*
```

### 3.2 `ai-plugin-marketplace/template` contents

```
template/
├── .github/workflows/         # Freshness check, release workflows
├── .claude-plugin/
│   └── marketplace.json       # Claude Code marketplace registry (see §4.4)
├── .cursor-plugin/
│   └── marketplace.json       # Cursor marketplace registry (see §4.4)
├── .agents/plugins/
│   └── marketplace.json       # Codex marketplace registry (see §4.4)
├── marketplace.json           # Open Plugins repo-root registry (see §4.4)
├── plugins/
│   └── <plugin-name>/         # Per-plugin directory — see §4
├── dist/                      # Generated standalone bundles (committed)
│   ├── gemini/
│   └── kiro/
├── package.json               # Depends on @ai-plugin-marketplace/cli
├── pnpm-lock.yaml
├── README.md
└── LICENSE
```

The template does **not** contain `src/`, `schemas/`, `tests/` for toolkit logic. That lives in `tools/`.

### 3.3 `ai-plugin-marketplace/tools` contents

```
tools/
├── packages/
│   ├── core/                  # @ai-plugin-marketplace/core
│   │   └── src/
│   │       ├── targets/       # Per-target internal modules (see §12.4)
│   │       │   ├── claude/
│   │       │   ├── cursor/
│   │       │   ├── gemini/
│   │       │   ├── kiro/
│   │       │   └── vercel/
│   │       ├── pipeline/      # Build pipeline with named transform step
│   │       ├── config.ts      # defineConfig, AipmConfig schema
│   │       └── index.ts       # Public exports
│   └── cli/                   # @ai-plugin-marketplace/cli
├── docs/specs/
│   └── architecture.md        # This document
├── .github/workflows/         # CI: typecheck, lint, test, publish
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### 3.4 Dependency direction

```
template → @ai-plugin-marketplace/cli
                         ↓
            @ai-plugin-marketplace/core
                         ↓
                  zod, yaml
```

**Invariant.** Dependencies flow one direction. A reverse edge indicates a design error. When future packages are extracted (§12.4), they become intermediate layers; the `template → cli → core` spine stays constant.

**Invariant.** Per-target modules under `core/src/targets/` must not import each other. This is enforced in CI (see §13 Phase A exit criterion) and is what makes the future per-target package extraction a mechanical `git mv` rather than a rewrite.

---

## 4. Plugin source layout

A plugin directory is the author's artifact: the smallest unit that ships to a user. Every plugin lives under `plugins/<plugin-name>/` in the template:

```
plugins/<plugin-name>/
├── aipm.config.ts             # Support envelope + plugin metadata (§6)
├── .claude-plugin/
│   └── plugin.json            # Claude Code manifest (hand-authored)
├── .cursor-plugin/
│   └── plugin.json            # Cursor manifest (hand-authored)
├── gemini-extension.json      # Gemini CLI manifest (hand-authored)
├── POWER.md                   # Kiro manifest with frontmatter (hand-authored)
├── GEMINI.md                  # Gemini CLI context (hand-authored)
├── .mcp.json                  # MCP config for Claude/Cursor (hand-authored)
├── mcp.json                   # MCP config for Kiro (hand-authored)
├── agents/                    # Agent definitions (.md, hand-authored)
├── commands/                  # Commands (.md and .toml, hand-authored)
├── hooks/
│   ├── claude.yaml            # YAML source (hand-authored)
│   └── claude.json            # Toolkit-generated from .yaml
├── skills/
│   └── <skill>/SKILL.md       # Skills (hand-authored)
├── steering/                  # Kiro steering (hand-authored)
├── rules/                     # Cursor/Claude rules (hand-authored)
├── README.md
└── LICENSE
```

### 4.1 Identity and version

- **Plugin identity** — the directory name, matching the `name` field in every per-target manifest (validated by §10.1.4).
- **Plugin version** — a semver string in `aipm.config.ts`, distinct from toolkit version and schema versions. See §9 for the three-axis versioning model.

### 4.2 Reserved file-naming conventions

These patterns are reserved for future use; v0.1.0 rejects them with a "not available in this toolkit version" error:

- `<name>.<target>.tsx` and `<name>.<target>.ts` — reserved for future TSX authoring (§12.3)
- `shared/*.tsx` — reserved for future shared TSX components

**Why reserve.** If v0.1.0 allowed these patterns for some unrelated purpose, adding TSX authoring would be a breaking change for plugins that used them.

### 4.3 Author-authored vs toolkit-generated

Every file under `plugins/<name>/` is one of:

- **Author-authored** — the author writes it; the toolkit reads but never modifies it.
- **Toolkit-generated** — the toolkit produces it from an author-authored source.

Toolkit-generated files include a sentinel as the first line (or in JSON, a `_generated` field) so hand-edits are detectable:

```
# Generated by @ai-plugin-marketplace/cli. Do not edit directly.
# Edit the source file listed in the sentinel and run `aipm build`.
# source: hooks/claude.yaml
# version: 0.8.0
```

The `# version:` line (JSON: `_generated.version`) records the **generation-engine** (`@ai-plugin-marketplace/core`) version that produced the file — see §4.3.1. In JSON the sentinel is a top-level `_generated` object emitted first:

```json
{
  "_generated": {
    "by": "@ai-plugin-marketplace/cli",
    "source": "hooks/claude.yaml",
    "version": "0.8.0"
  }
}
```

**Sidecar variant for strict-schema hosts.** Some host platforms reject unknown top-level fields in their manifests (e.g., Gemini's `gemini-extension.json`, Kiro's `.kiro/agents/*.json`). For these formats, the sentinel is stored in a sidecar file `<artifact>.generated` alongside the artifact rather than inline. The freshness check reads either form.

The freshness check (§10.5) rejects any generated file whose content doesn't match what `aipm build` would produce, whether because the source changed or because the output was hand-edited — **except** for the generator-version stamp: two otherwise-identical artifacts differing only in their stamped `version` are NOT stale (a version bump alone must not flip every artifact to stale; version safety is enforced by the build guard in §4.3.1, not by freshness).

### 4.3.1 Generator-version stamp and downgrade guard

`aipm build` regenerates artifacts using whatever `@ai-plugin-marketplace/core` version is installed in `node_modules`. Without a guard, a checkout whose install is **older** than the version that produced the committed artifacts (common when multiple worktrees/checkouts each carry their own `node_modules`) silently reverts those files to the older generator's output — a working-tree diff that is easy to commit unnoticed, and that `aipm validate` cannot catch because it validates against the same stale toolkit.

To prevent this, every sentinel-carrying artifact is **stamped** with the generation-engine version (`@ai-plugin-marketplace/core`'s own `package.json#version`, read at runtime — never hardcoded), and each build enforces a **downgrade guard** before writing anything:

1. **Stamp.** Both sentinel carriers record the version: JSON artifacts as `_generated.version`, inline/sidecar artifacts as a `# version:` line. The version is the core package version because core is the engine that actually produces the bytes (the human-facing `by` field remains the CLI id).
2. **Guard.** At the start of `aipm build`, the toolkit reads the stamped version of every existing (committed) sentinel-carrying artifact. If the installed core version is **older** (by semver precedence, not string comparison) than any stamped version, the build **refuses** with a non-zero exit and a message naming both versions and suggesting `pnpm install`. Equal-or-newer installs, unstamped/first-time trees, and an empty artifact set all proceed and (re)stamp with the installed version. The `--force-downgrade` flag overrides the guard, proceeding and restamping with the older version.
3. **All-or-nothing.** The guard runs before any write, so a refusal leaves the whole tree untouched — including the **sentinel-less** artifacts (`dist/**` bundles, marketplace registries, single-artifact-host root files), which carry no stamp of their own but are protected transitively: as long as at least one stamped artifact reveals the downgrade, the build aborts and rewrites nothing. A repo whose hooks-authoring plugins all emit at least one stamped hook artifact is fully covered; the guard's coverage is the union of stamped artifacts across the repo.

### 4.4 Marketplace registry

The toolkit generates **four** repo-root marketplace registries, one per registry-backed target (each emitted only when at least one plugin declares that target): `.claude-plugin/marketplace.json` (Claude), `.cursor-plugin/marketplace.json` (Cursor), `.agents/plugins/marketplace.json` (Codex), and — as the 4th — a repo-root `marketplace.json` (Open Plugins, at the spec's lookup position 1; see `open-plugins-target.md` OP-D3). All live at the **template repo root**, not in any single plugin. They are template-level registries listing every plugin by name and source path. Each plugin contributes an entry; the registries themselves are owned and validated at the template level. Consistency between plugins and their registry entries is checked by §10.1.4. The repo-root `marketplace.json` is additionally collision-guarded via the generated-root sidecar (a pre-existing foreign file raises a hard `root-artifact-collision`).

---

## 5. Phases of work

The build lifecycle has three distinct phases. Keeping them separated avoids the ordering bugs that come from treating build and validate as one step.

### 5.1 Author phase

Author writes source files. Nothing runs except the TypeScript compiler (checking `aipm.config.ts`) and the author's editor. No artifacts are emitted.

### 5.2 Build phase

Invoked by `aipm build`. The pipeline:

```
Load PluginSource (author-authored files from plugins/<name>/)
         ↓
transform(PluginSource) → PluginBuild
         ↓
Emit PluginBuild artifacts (write generated files into plugin dir + dist/)
```

The **transform step** is a single named seam. In v0.1.0 it performs only mechanical transformations (§7). In a future release, a JSX renderer slots into this seam (§12.4).

### 5.3 Validate phase

Invoked by `aipm validate` (or as a subphase of `aipm build`). Inspects on-disk state (sources and generated outputs) and returns findings. Does not modify the filesystem.

### 5.4 Phase invariants

- Author produces inputs; Build produces outputs; Validate inspects both.
- `aipm build` always runs `aipm validate` before returning success in CI; locally it emits warnings and continues.
- No phase calls another's internals; they communicate through on-disk state.

---

## 6. Support envelope

### 6.1 Declaration

Every plugin has an `aipm.config.ts` declaring its supported targets and version:

```ts
// plugins/my-plugin/aipm.config.ts
import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '0.1.0',
  targets: ['claude', 'cursor', 'gemini'],
});
```

`defineConfig`:

- Takes input typed as `AipmConfigInput` and returns a branded `AipmConfig`. The brand symbol is module-private (never exported), so consumer code sees `AipmConfig` as `AipmConfigInput` plus a structural marker proving `defineConfig` validated it. Users re-annotating in another file should write `const cfg: AipmConfig = defineConfig({...})` to preserve the brand; skipping the wrapper fails at the type level.
- Uses `.strict()` Zod parsing — unknown keys are errors, not silent passthrough.
- Requires `version` to be a valid semver string.
- Restricts `targets` to the `TargetId` union — typo'd IDs (`'cluade'`) fail at `tsc` before runtime.

### 6.2 What the envelope means

- For each target in the envelope, the plugin MUST produce the minimum required artifacts.
- For each target NOT in the envelope, the plugin MUST NOT produce artifacts. A plugin with `targets: ['claude']` that contains `gemini-extension.json` is a validation error.
- Unsupported targets receive no output — the plugin is invisible to users of that target.

### 6.3 Why the envelope is declarative

The toolkit could infer it from file presence. It doesn't, because:

- **Intent clarity.** A plugin with only Claude manifests may support only Claude — or it may be in-progress. The explicit declaration distinguishes.
- **Validation leverage.** The validator can emit "you declared `kiro` but provided no Kiro sources" rather than silently producing an incomplete plugin.

### 6.4 Compatibility-assist tooling

Because the toolkit does not auto-adapt across targets (P2), it provides explicit tooling that helps authors expand their envelope:

- **`aipm check-support <plugin>`** — reports which targets are declared but missing required artifacts, and which targets could plausibly be added, with a concrete list of files the author would need to write.
- **`aipm add-target <plugin> <target>`** — scaffolds skeleton files for a new target, leaving manifest fields blank for the author. **Preserve-or-warn, never destructive**: an existing file the target would write is never overwritten; it's left untouched and reported. When every file the target would write already exists, the call is a friendly no-op (not an error) — a target that's already materialized is the desired end state, not a conflict. Placeholder fields a schema requires to be non-empty (e.g. Vercel's `SKILL.md` `description`) are emitted as non-empty placeholder prose rather than blanked, so add-target's own output always passes `aipm build`/`aipm validate` (issue #90).
- **`aipm list-targets`** — lists the target IDs this toolkit version knows about.

The toolkit's position: _you own the authoring decisions; we make them cheap to execute._

---

## 7. Mechanical transformations

### 7.1 What qualifies as mechanical

A transformation is mechanical iff it is a **pure function driven by a committed lookup table**, bounded to a single target. Stricter than "deterministic"; forces transformations to be inspectable as data.

### 7.2 Transformations shipped in v0.1.0

| Transformation                                                         | Target      | Lookup / logic lives in                         |
| ---------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| `Read`/`Edit`/`Grep`/… → `read_file`/`replace`/`search_file_content`/… | Gemini CLI  | `core/src/targets/gemini/tool-names.ts`         |
| `Read`/`Edit`/`Grep`/… → `read`/`write`/`grep`/…                       | Kiro        | `core/src/targets/kiro/tool-names.ts`           |
| `hooks/claude.yaml` → `hooks/claude.json`                              | Claude Code | `core/src/targets/claude/hooks.ts` (structural) |
| Agent `.md` → `.kiro/agents/<name>.json`                               | Kiro        | `core/src/targets/kiro/agents.ts`               |
| Plugin dir → `dist/gemini/<plugin>/`                                   | Gemini CLI  | `core/src/targets/gemini/bundle.ts`             |
| Plugin dir → `dist/kiro/<plugin>/`                                     | Kiro        | `core/src/targets/kiro/bundle.ts`               |

All of these live in per-target internal modules. The pipeline dispatches to them; it holds no target-specific logic.

### 7.3 Explicitly not mechanical

Forbidden by P1/P4:

- Translating a Claude hook to a Kiro hook
- Synthesizing a Vercel SKILL.md from a Claude agent
- Inferring a Gemini manifest from a Claude manifest
- Translating a Cursor rule from a Claude rule

Once this line is crossed, every new target adds quadratic translation complexity. Hold it.

---

## 8. Toolkit packages and public API

### 8.1 `@ai-plugin-marketplace/core`

**Purpose.** Build pipeline, validation, scaffolding, migrate (no-op today; real in a future release), and `defineConfig`. Per-target schemas and transformations live as internal modules under `core/src/targets/` and are not public exports.

**Public exports.**

```ts
// Config
export interface AipmConfigInput {
  version: string; // semver, enforced
  targets: TargetId[]; // subset of known IDs, enforced
}

// Brand symbol is module-private (not exported). AipmConfig is opaque to consumers
// except for the fields inherited from AipmConfigInput.
declare const aipmConfigBrand: unique symbol;
export type AipmConfig = AipmConfigInput & { readonly [aipmConfigBrand]: 'AipmConfig' };

export function defineConfig(config: AipmConfigInput): AipmConfig;

// Operations
export function init(dir: string, opts?: InitOptions): Promise<InitOutcome>;
export function build(path: string, opts?: BuildOptions): Promise<BuildResult[]>;
export function validate(path: string, opts?: ValidateOptions): Promise<ValidationResult>;
export function scaffold(name: string, opts: ScaffoldOptions): Promise<void>;
export function migrate(path: string, opts?: MigrateOptions): Promise<MigrateResult>;
export function checkSupport(pluginDir: string): Promise<SupportReport>;
export function addTarget(pluginDir: string, target: TargetId): Promise<AddTargetOutcome>;
export function listTargets(): TargetId[];

// Types
export type TargetId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'gemini'
  | 'kiro'
  | 'open-plugins' // vendor-neutral Open Plugins standard (open-plugins.com); see open-plugins-target.md
  | 'vercel';

export interface BuildResult {
  plugin: string; // plugin name
  pluginDir: string; // absolute path
  artifacts: GeneratedFile[]; // every file the build produced or verified
  durationMs: number;
}

// `'shared'` marks an artifact with no single owning target — e.g. the payload adapter (emitted
// for any plugin authoring hooks, independent of envelope) or the generated-root sidecar manifest
// (spans every emitted single-artifact-host/registry owner). Never added to `TargetId` itself.
export type GeneratedFileTarget = TargetId | 'shared';

export interface GeneratedFile {
  path: string; // absolute path
  source?: string; // the author-authored file this was generated from
  target: GeneratedFileTarget; // which target's build step produced it, or 'shared'
}

export interface ValidationResult {
  findings: Finding[];
  passed: boolean; // true iff no hard findings. Soft findings do not flip it.
}

// Enumerated finding codes. Additive — new codes arrive in toolkit MINOR releases;
// removing or renaming a code is MAJOR. Consumers SHOULD handle unknown codes gracefully.
export type FindingCode =
  | 'envelope-invalid' // aipm.config.ts is malformed or missing (including a plugin-shaped dir with no config at all)
  | 'repo-config-invalid' // aipm.repo.ts is malformed
  | 'envelope-adherence' // file exists for a target outside the envelope
  | 'schema-invalid' // target manifest failed Zod validation
  | 'name-consistency' // plugin name mismatch across manifests
  | 'version-consistency' // target manifest version mismatch vs aipm.config.ts
  | 'mcp-key-sync' // .mcp.json vs mcp.json server keys diverge
  | 'marketplace-registration' // plugin-to-registry projection is wrong
  | 'freshness' // generated file drifted from what `aipm build` would produce
  | 'single-artifact-host' // a single-artifact host (gemini/kiro) is declared by >1 plugin
  | 'root-artifact-collision' // a generated repo-root path is occupied by a non-toolkit file
  | 'default-marketplace-name' // marketplace name/owner is still a template placeholder (always soft)
  | 'frontmatter-invalid' // a skill/agent/command/POWER.md frontmatter is not strict YAML
  | 'metadata-dir-isolation' // the Open Plugins `.plugin/` dir holds more than plugin.json (hard, open-plugins target)
  | 'open-plugins-conformance'; // soft advisory: native plugin is not Open-Plugins-portable (arrives with the conformance PR)

export interface Finding {
  severity: 'hard' | 'soft';
  code: FindingCode;
  plugin?: string;
  message: string;
  hint?: string;
}

export interface MigrateResult {
  // Discriminant so consumers distinguish "ran and did nothing" from "ran and applied zero of N"
  // from "ran and failed." Retrofitting this later would be breaking.
  status: 'no-migrations-needed' | 'applied' | 'failed';
  migrationsApplied: number; // 0 in v0.1.0
  filesChanged: string[];
}

export interface InitOptions {
  name?: string; // repo name in the generated package.json; defaults to basename(dir)
}

export interface InitOutcome {
  // absolute path to an ancestor pnpm-workspace.yaml, if one exists above `dir` (issue #96
  // ancestor-workspace-contamination guard); undefined when none was found
  ancestorWorkspace?: string;
}
```

**Why `init` lives in `core`.** `init` scaffolds the thin consumer repo described in §3.2 — `package.json` (private, ESM, with the `@ai-plugin-marketplace/cli` dev dependency pinned to a caret of the current toolkit version), both repo-root marketplace registries, an empty `plugins/`, a README, and a CI workflow that runs `aipm build` then `aipm validate` (§10.5). Pinning the dev dependency in lockstep with `core` (§9.1) is the seam that makes `pnpm up` the single upgrade path (§11). It refuses to write into a non-empty directory.

**Ancestor-workspace guard (issue #96).** `init` always writes a local `package.json`, but a directory nested under an ancestor `pnpm-workspace.yaml` can still have a later `pnpm install` swept into that ancestor workspace (shared lockfile/hoisting) instead of staying local. `init` walks up from the target directory looking for an ancestor `pnpm-workspace.yaml` and reports it via `InitOutcome.ancestorWorkspace`; the `aipm init` CLI surface prints a warning to stderr when it is set, before instructing the user to run `pnpm install`.

**Why one `build` signature.** `path` may be a plugin directory or the repo root; the function detects which and either builds one plugin or all. Returns a length-1 array for single-plugin input. Avoids forking the return type on an operational detail.

**Why `migrate` ships as a no-op.** The command name is part of the upgrade UX (§11.3 major-upgrade flow). Shipping it now — prints `"no migrations needed"`, returns `{ status: 'no-migrations-needed', migrationsApplied: 0, filesChanged: [] }`, exits 0 — means the command exists at 1.0 and future toolkit versions can plug in real migrations without a CLI surface change.

**Forward note for future migrate implementations.** When real migrations ship, `migrate` must distinguish _up-to-date_ from _unknown future version_ (the on-disk `schemaVersion` is newer than the toolkit knows about — the toolkit itself is stale). The v0.1.0 no-op response is honest _only because_ §9.4 constrains every `schemaVersion` to a single value; removing that invariant requires richer status handling.

**Not exported.** Per-target schemas, transformations, tool-name tables, validators, internal target-module interface, pipeline internals. These are `internal/` and move freely between minor versions.

**`package.json` `exports` field.** In v0.1.0 the **only public subpath is the package root**. All public types and functions import from `@ai-plugin-marketplace/core` directly — there is no `/types`, `/config`, or `/targets` public subpath. Importing from `@ai-plugin-marketplace/core/internal/...` is blocked by the `exports` field. Keeping the public surface to a single subpath means future subpath additions are additive rather than collisions.

### 8.2 `@ai-plugin-marketplace/cli`

**Purpose.** Thin binary wrapper around `core`.

**Bin.** `aipm`

**Why `aipm` and not `apm`.** `apm` collides with Atom Package Manager (still widely installed) and Adobe Asset Platform tooling. First-in-PATH wins silently.

**Subcommands.**

| Subcommand                          | Wraps                                  |
| ----------------------------------- | -------------------------------------- |
| `aipm init [dir]`                   | `core.init(dir)` — default cwd         |
| `aipm build [path]`                 | `core.build(path)` — default cwd       |
| `aipm validate [path]`              | `core.validate(path)`                  |
| `aipm scaffold <name>`              | `core.scaffold(name)`                  |
| `aipm migrate [path]`               | `core.migrate(path)` — no-op in v0.1.0 |
| `aipm check-support <plugin>`       | `core.checkSupport(pluginDir)`         |
| `aipm add-target <plugin> <target>` | `core.addTarget(pluginDir, target)`    |
| `aipm list-targets`                 | `core.listTargets()`                   |

**Naming convention.** CLI subcommand names are kebab-case; `core` exports are camelCase. The CLI handles the mapping at its argv boundary; downstream consumers never see the hyphenated form.

The CLI does argument parsing, output formatting, and exit codes. No business logic.

### 8.3 Future packages

Non-binding. Candidates for extraction when internal modules grow large enough to justify publication overhead:

- `@ai-plugin-marketplace/schemas` — Zod schemas + (when adopted) migrex graphs
- `@ai-plugin-marketplace/jsx` — JSX factory + host components when TSX authoring ships
- `@ai-plugin-marketplace/target-<id>` — per-target bundle

Extractions are additive and do not break existing consumers. See §12.4 for the seam.

---

## 9. Versioning contract

### 9.1 Three independent version lines

| Axis                                     | What it versions                                   | Where it lives                                          |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Toolkit version**                      | The `@ai-plugin-marketplace/*` packages (lockstep) | Each package's `package.json`                           |
| **Plugin version**                       | The author's plugin content                        | `version` field in `aipm.config.ts`                     |
| **Schema version** (per manifest family) | The shape of a target's manifest                   | Reserved `schemaVersion` field in each manifest (§12.2) |

Independent: a patch toolkit release may leave all plugin and schema versions unchanged; a plugin author publishing `v1.2.0` does not trigger a toolkit version change.

### 9.2 Toolkit-to-schema coupling

| Change                                                      | Toolkit semver | Schema version                  |
| ----------------------------------------------------------- | -------------- | ------------------------------- |
| Bug fix, no API or schema change                            | Patch          | Unchanged                       |
| New target added                                            | Minor          | New schema starts at `0.1.0`    |
| New optional field on existing schema                       | Minor          | Minor bump on that schema       |
| Schema breaking change (removed or typed-differently field) | Major          | Major bump (migration required) |
| Public `core` API breaking change                           | Major          | N/A                             |

### 9.3 Author-facing invariant

**A minor or patch toolkit upgrade never requires you to change your plugin manifests. Major toolkit upgrades may require running `aipm migrate` (a no-op today; real in future releases); the CLI tells you when.**

This is the guarantee that makes `pnpm up` safe for plugin authors. Everything else exists to defend it.

### 9.4 `schemaVersion` in v0.1.0

Every target manifest carries a `schemaVersion` string. Scaffolds emit `schemaVersion: "0.1.0"` for every manifest. **Validators do not check it in v0.1.0** — the field is reserved against the future migrex adoption (§12.2), but policing a field with exactly one legal value is ceremony, so v0.1.0 treats it as opaque data. When the first real migration is authored, `aipm migrate` reads the field to decide the starting point.

---

## 10. Validation contract

### 10.1 What `aipm validate` checks

**Discovery is not exempt from this contract.** A repo-root `plugins/*` subdirectory that carries a target manifest (e.g. `.claude-plugin/plugin.json`) and/or a skill (`skills/*/SKILL.md`) is **plugin-shaped**, and discovery includes it whether or not it also carries `aipm.config.ts`. A plugin-shaped directory missing its config is therefore not silently dropped from the plugin list — it reaches validator step 1 below like any other plugin and fails there with `envelope-invalid`, rather than `aipm validate`/`aipm build` reporting a false "nothing to do" success. Only a directory with **neither** a config nor any plugin-shape marker is excluded — it genuinely is not a plugin. `aipm build` mirrors this: it throws the same missing-config error building a plugin-shaped-but-configless directory would produce for a directly-targeted single plugin, rather than silently building zero plugins.

Validators run in defined order; each either passes or emits findings:

1. **Envelope validation** — every `aipm.config.ts` parses strictly; `version` is semver; `targets` is a non-empty subset of known IDs. A plugin-shaped directory with no `aipm.config.ts` at all fails here too (`envelope-invalid`), not just a malformed one.
2. **Schema validation** — every target manifest parses against the current Zod schema for that target.
3. **Envelope adherence** — no files exist for a target outside the envelope; every in-envelope target has its minimum required files.
4. **Cross-target consistency** (only when the envelope contains multiple targets):
   - `name` consistency across all manifests and the plugin directory name.
   - MCP server key sync between `.mcp.json` (Claude/Cursor) and `mcp.json` (Kiro).
   - Marketplace registration: the plugin is listed in `.claude-plugin/marketplace.json` iff `claude` is in the envelope; likewise for Cursor.

### 10.2 Failure semantics

- Envelope, schema, and adherence errors are **hard**.
- Cross-target consistency mismatches are **hard**.
- Freshness mismatches (see §10.5) are **hard** in CI, **soft** locally.
- `ValidationResult.passed` is `true` iff no hard findings were emitted. Soft findings do not flip it.

### 10.3 Order matters

Schema errors block cross-target checks (no point comparing unparseable manifests). Envelope errors block schema errors (no point validating a target the author didn't declare). Fail fast on the most fundamental issue.

### 10.4 Example — envelope adherence

```
plugins/my-plugin/
├── aipm.config.ts              # targets: ['claude']
├── .claude-plugin/plugin.json  # OK — claude is in envelope
└── gemini-extension.json       # ERROR — gemini not in envelope
```

Output:

```
[my-plugin] envelope-adherence: gemini-extension.json targets 'gemini' which is not in the envelope {targets: ['claude']}
    hint: run 'aipm add-target my-plugin gemini' to declare gemini support, or delete this file
```

### 10.5 Freshness check

Running `aipm build` produces a clean git tree. The check is implemented once, lives in the validator layer, and is referenced from CI workflows. Sources of drift:

- An author-authored file changed but `aipm build` hasn't been re-run.
- A toolkit-generated file was hand-edited (detectable via the sentinel in §4.3).

Both surface as a single `freshness` finding with the specific file path.

The comparison is **version-stamp-agnostic** (§4.3.1): an artifact that differs from a fresh build ONLY in its stamped generator `version` is not flagged, so bumping `@ai-plugin-marketplace/core` does not mark every committed artifact stale. Whether the installed toolkit is safe to build with (older vs. the version that produced the committed files) is a separate concern, enforced by the build downgrade guard (§4.3.1), not by freshness.

---

## 11. Template → toolkit dependency contract

### 11.1 Pinning

With two packages, the template's `package.json` is simple:

```json
{
  "dependencies": {
    "@ai-plugin-marketplace/cli": "^0.1.0"
  }
}
```

`cli` pins its `core` dependency to an exact version; transitively the template always gets a consistent pair. No `pnpm.overrides` needed in v0.1.0.

### 11.2 Pinning when more packages exist

When additional packages are extracted (§12.4), the template will depend on a single meta-package whose `dependencies` pin all `@ai-plugin-marketplace/*` packages to the same version. Either `cli` continues to be the meta-package, or a new `@ai-plugin-marketplace/preset` is introduced.

**Why a meta-package instead of `pnpm.overrides`.** `pnpm.overrides` ties the template to pnpm. A meta-package works for any package manager.

### 11.3 Upgrade flow

Routine minor/patch:

```
pnpm up @ai-plugin-marketplace/cli
aipm build
git commit -am "chore: upgrade @ai-plugin-marketplace to X.Y.Z"
```

Major:

```
pnpm up @ai-plugin-marketplace/cli@latest
aipm migrate
aipm build
git commit -am "chore: upgrade to @ai-plugin-marketplace vN"
```

### 11.4 What the template may customize

- GitHub Actions workflows (beyond the freshness check)
- Top-level `README.md`, `LICENSE`
- Additional tooling (linters, test runners) that doesn't conflict with the toolkit
- Plugin sources in `plugins/`

### 11.5 What the template must not do

- **Vendor or fork `@ai-plugin-marketplace/*`.** Published dependencies only.
- **Skip the freshness check.** CI must run `aipm build` and fail on drift.
- **Re-implement scaffold, validate, or build outside the toolkit.** File an upstream issue instead.

---

## 12. Forward-compatibility seams

Each seam is a low-cost commitment in v0.1.0 that keeps a known-future capability cheap to add. Five seams, grouped by kind:

### Reservations

### 12.1 `version` in `aipm.config.ts`

Required, semver-enforced, from day 1 (§6.1). Future marketplace and changelog tooling consume this without needing to invent a plugin version. **Retrofit cost without this seam:** moderate — downstream tooling would need fallback inference.

### 12.2 `schemaVersion` on every manifest

Every target manifest carries a `schemaVersion` field from day 1. Scaffolds emit it at `"0.1.0"`. Validators ignore it in v0.1.0 (§9.4). When migrex is adopted, this field is the migration-graph starting node — no retroactive version inference needed. **Retrofit cost without this seam:** high — version inference from manifest structure is fragile.

### 12.3 Reserved `<name>.<target>.tsx` naming

Reserved in v0.1.0 (§4.2); plugins containing `.tsx` files fail validation. When TSX authoring ships, the names become meaningful. **Retrofit cost without this seam:** low-to-moderate — early plugins could use the pattern for unrelated purposes, blocking future adoption.

### Structural anchors

### 12.4 Named `transform` step + per-target folder layout

The v0.1.0 build pipeline (§5.2) has a single named transform step; target-specific code lives in per-target folders under `core/src/targets/` (§3.3). When TSX renderers arrive, they plug into the transform step without reshaping the pipeline. When per-target packages are extracted (§8.3), each extraction is a `git mv` of a folder into a new package — not a redesign.

**This seam is enforced by CI.** Per-target folders may not import each other (§3.4 invariant). A cross-target-import lint check runs in CI. Without this check, the "cheap `git mv`" claim would be aspirational.

**Retrofit cost without this seam:** moderate — adding rendering would be a pipeline-wide refactor.

### 12.5 Internal target-module interface

The per-target folders conform to a common internal shape. Reference file layout:

```
core/src/targets/<target>/
├── schemas.ts      # Zod schemas for this target's manifests
├── transform.ts    # Mechanical transformations (tool-name tables, YAML→JSON, etc.)
├── validate.ts     # Target-specific validation rules
├── scaffold.ts     # Scaffold templates for 'aipm scaffold' and 'aipm add-target'
└── bundle.ts       # Optional — standalone-bundle assembly (Gemini, Kiro only)
```

The exact interface tying these together is **not specified in this spec and not exported**. It will be iterated through our own target additions and publicized only when a real third-party adapter request motivates it.

**Why this isn't a full interface spec.** Freezing the adapter shape in v0.1.0 before any third-party has tried to implement one would be premature. Keeping the interface internal lets us revise freely.

**Retrofit cost without this seam:** low — we're not promising third-party adapters in v0.1.0. The cost appears only if we published an adapter API now and had to break it later.

---

## 13. Bootstrap and cutover plan

Three phases.

### Phase A — Build and publish the toolkit

- Create `github.com/ai-plugin-marketplace/tools` (pnpm monorepo).
- Set up packages: `core`, `cli`.
- Port `src/validate.ts`, `src/scaffold.ts`, `src/build-standalone.ts`, `src/build-hooks.ts` into `core`, refactored to the API surface in §8.1. Per-target logic lands in `core/src/targets/<target>/`.
- Port `schemas/*.json` to Zod in `core/src/targets/*/schemas.ts`.
- Add `schemaVersion: "0.1.0"` to scaffolded manifests (§12.2).
- Add generated-file sentinels to every toolkit-generated artifact (§4.3).
- Port `tests/validate.test.ts` as the starting test suite.
- **Exit criteria (all required):**
  1. _Feature parity_ — running the new CLI against a checked-out copy of the current template produces semantically identical output (same files; JSON compared with sorted keys; same validation findings). Documented as a golden-file fixture.
  2. _Package shape_ — `pnpm pack` produces a tarball; installing the tarball into a clean project works end-to-end.
  3. _Cross-target isolation_ — a CI check (eslint `no-restricted-imports` with a path pattern, or equivalently dependency-cruiser with a forbidden-edge rule) confirms no file under `core/src/targets/<X>/` imports from `core/src/targets/<Y>/` for any X ≠ Y.
- Cut `@ai-plugin-marketplace/core@0.1.0` and `@ai-plugin-marketplace/cli@0.1.0`.

### Phase B — Cut the template over

- Create `github.com/ai-plugin-marketplace/template` (transfer or re-init from `mike-north/ai-plugin-marketplace-template`).
- Remove `src/`, `schemas/`, toolkit `tests/`.
- Keep `plugins/`, `dist/`, `.claude-plugin/`, `.cursor-plugin/`, slim `package.json` depending on `@ai-plugin-marketplace/cli`.
- Add `aipm.config.ts` and `schemaVersion: "0.1.0"` to every existing plugin's manifests.
- Template CI runs `aipm build` + `aipm validate` + freshness check.

**Exit criterion.** The template repo builds end-to-end with no toolkit source inside it.

### Phase C — Stabilize to 1.0.0

- Accumulate real use: at least one plugin beyond `skill-evaluator` from an external author.
- Resolve open questions (§15).
- Cut `@ai-plugin-marketplace/*@1.0.0` when the API and schemas feel stable.

**Exit criterion.** Two or more external authors have shipped plugins.

---

## 14. Non-goals

Proposals that require these will be rejected unless accompanied by a replacement spec.

- **A unified manifest format.** P1. Note this forbids the toolkit **inventing** a unified authoring format that authors write into and the toolkit fans out from; adopting an **externally standardized** host format (Open Plugins, open-plugins.com) as one more target — projected from the same authored source as every other target — is P1-conformant, not a violation (see `open-plugins-target.md` OP-D1).
- **Automatic cross-target adaptation.** P2, §7.3.
- **Runtime execution of plugins.** Build-time only.
- **Lowest-common-denominator fallback as a toolkit responsibility.** Vercel Skills CLI support is authored explicitly, like any other target.
- **Target feature parity.** Claude hooks, Kiro hooks, and Gemini agent tooling are not equivalent; we don't pretend otherwise.
- **Replacement of target documentation.** The toolkit is not a tutorial.
- **Non-TypeScript authoring surface.** Plugin content files (`.md`, `.json`) are language-neutral, but `aipm.config.ts` is TypeScript.
- **Migration infrastructure before migrations exist.** The field in §12.2 is enough until migrex is needed.
- **Public third-party target-adapter interface before a real third party needs one.** §12.5.

---

## 15. Open questions

### 15.1 Hook-model cross-target diagnostics

Should `aipm check-support` inspect Claude hooks and suggest semantically-similar Kiro steering patterns? Diagnostic output, not code generation. Probably yes; defer to a compatibility-assist follow-up spec.

### 15.2 Packaging of compatibility-assist tooling

A separate package, CLI commands on `aipm`, AI-assistant skills, or all three? Initial implementation is `aipm check-support` + `aipm add-target` + `aipm list-targets`; scope expands with usage.

### 15.3 Marketplace federation

How does a plugin author publish to multiple marketplaces (Claude Code, Cursor, future registries)? Current model assumes a single marketplace per registry. Out of scope for this spec.

### 15.4 Plugin testing

How do authors test their plugins? A `@ai-plugin-marketplace/testing` package (or module) with helpers for asserting on build output and validation results may be needed. Defer until an author asks.

---

## Appendix A — Glossary

- **Artifact** — any file in a plugin directory, whether author-authored or toolkit-generated.
- **Build phase** — the stage in which `aipm build` transforms author-authored sources into toolkit-generated outputs. See §5.2.
- **Envelope** — the set of targets a plugin declares support for in `aipm.config.ts`. See §6.
- **Manifest** — a structured configuration file for a specific target (e.g., `.claude-plugin/plugin.json`, `gemini-extension.json`). Distinct from free-form content files like `POWER.md` or `SKILL.md`.
- **Mechanical transformation** — a pure function driven by a committed lookup table, bounded to a single target. See §7.1.
- **PluginSource** — the on-disk author-authored files of a plugin. Input to Build.
- **PluginBuild** — the on-disk state after Build runs, comprising PluginSource plus toolkit-generated outputs.
- **Plugin version** — a semver string in `aipm.config.ts` identifying the author's release of plugin content. Distinct from toolkit version and schema versions. See §9.
- **Schema version** — the shape version of a target's manifest, stored in the manifest's `schemaVersion` field. Reserved in v0.1.0; consumed by future migrations. See §9.4, §12.2.
- **Target** — a host-platform identity: `claude`, `cursor`, `gemini`, `kiro`, `vercel`, and future additions. A value, not a module.
- **Target module** — the internal toolkit code implementing a target. Lives under `core/src/targets/<id>/`. Interface is internal and unstable in v0.1.0.
- **Toolkit version** — the semver of `@ai-plugin-marketplace/*` packages, released in lockstep. See §9.
- **Transform step** — the named middle stage of the build pipeline: `transform(PluginSource) → PluginBuild`. The pipeline's seam for future renderers. Distinct from `transform.ts`, which names the per-target module file that implements the per-target portion of this stage.
- **Validate phase** — the stage in which validators inspect on-disk state and emit findings. See §5.3.

---

## Appendix B — Change log

| Version | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0   | 2026-04-19 | Initial draft: four-package split, TSX host components, full migrex infrastructure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 0.2.0   | 2026-04-19 | Narrowed to two packages; deferred TSX and migrex; added forward-compatibility seams; integrated first review pass (bin rename, collapsed `build`/`buildAll`, explicit phase boundaries, first-class plugin version, marketplace.json ownership clarified).                                                                                                                                                                                                                                                                                                                                                                                             |
| 0.3.0   | 2026-04-19 | Trimmed ceremony (removed internal-interface spec, collapsed duplicated rationale, dropped justifying-absence section); clarified `schemaVersion` as reserved-but-unvalidated in v0.1.0; added `migrate` and `list-targets` surfaces; pinned `BuildResult` shape; added generated-file sentinel; added cross-target-import CI check to bootstrap exit criteria.                                                                                                                                                                                                                                                                                         |
| 0.4.0   | 2026-04-19 | Pre-1.0 API tightening: `Finding.code` as typed additive `FindingCode` union; dropped unused `'shared'` from `GeneratedFile.target`; split `AipmConfigInput` → branded `AipmConfig` with module-private brand symbol; `MigrateResult.status` discriminant added. Concrete reference file layout for per-target modules; cross-target-import CI tool named; sidecar-sentinel option for strict-schema hosts; public-subpath policy stated (root only in v0.1.0); migrate no-op caveat for future compatibility. Cuts: §13.1 "what must not happen during bootstrap" (restated elsewhere); redundant §1.3 sentence.                                       |
| 0.4.1   | 2026-05-31 | Added `init` to the public API: `core.init(dir, opts?)` + `aipm init [dir]` scaffold the thin consumer repo of §3.2 (private/ESM `package.json` with the `@ai-plugin-marketplace/cli` dev dependency pinned to a caret of the current toolkit version, both repo-root marketplace registries, empty `plugins/`, README, and a build→validate CI workflow). This makes the template generatable from the CLI and centrally versioned via `pnpm up` (§11).                                                                                                                                                                                                |
| 0.4.2   | 2026-07-15 | Reintroduced `'shared'` to `GeneratedFile.target` (now `GeneratedFileTarget = TargetId \| 'shared'`), 0.4.0 having dropped it as unused. Two build-internal artifacts genuinely have no single owning target — the payload adapter (and its sidecar), emitted for any plugin authoring hooks regardless of envelope, and the generated-root sidecar manifest, which spans every emitted single-artifact-host/registry owner — and had each been attributed to an arbitrary, deterministically-chosen single target as a workaround. Both now report `target: 'shared'` honestly instead. Breaking change to the `@public` `GeneratedFile.target` field. |
| 0.4.3   | 2026-07-18 | Added the generator-version stamp + downgrade guard (§4.3.1): sentinel-carrying artifacts now record the producing `@ai-plugin-marketplace/core` version (`_generated.version` / `# version:` line), and `aipm build` refuses (non-zero exit, or `--force-downgrade`) when the installed toolkit is older than a stamped version — closing the silent-revert failure mode where a stale `node_modules` reverts committed artifacts to an older generator's output. Freshness (§10.5) compares modulo the version stamp so a version bump alone is not "stale". New `BuildOptions.forceDowngrade`.                                                       |
