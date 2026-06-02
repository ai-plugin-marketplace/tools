# Design Spec: Manifest & Registry Codegen

> **Status:** design spec (no implementation). Locked decisions: codegen owns the **shared, derivable** parts of each manifest while **per-target specifics stay hand-authorable as overrides** (preserves principle P1); generated files are **committed and freshness-checked** (consistent with `hooks/*.json` and `dist/` today); scope covers **per-target manifests + the marketplace registries + an `aipm init --embedded`** flow.

## Context & motivation

Authoring a plugin today means repeating the same facts in many places, by hand:

- **`version`** lives in `aipm.config.ts` (the plugin's release version, spec §9) **and** is re-typed into every target manifest (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `POWER.md` frontmatter, `.cursor-plugin/plugin.json`). They can silently drift.
- **`name` / `description` / `author` / `keywords`** are duplicated across those same up-to-five manifests.
- **Component lists** — `skills`, `agents`, `commands`, `hooks` path arrays in `plugin.json` — are maintained by hand even though the files already exist on disk under `skills/`, `agents/`, etc.
- **Marketplace registries** — the three `marketplace.json` files — are hand-edited for top-level metadata, and (per the [embedded-marketplace guide](../guides/embedded-marketplace.md), step 5) this is an explicit manual chore.

The intended outcome: **declare each fact once**, let the toolkit generate the derivable manifest/registry content, and keep per-target native fidelity available as a hand-authored override. This removes the duplication without abandoning the toolkit's "per-target native authoring" principle.

## The P1 tension (and the reconciliation)

The architecture's **P1 — per-target native authoring, no universal manifest** — exists so each host gets full native fidelity. "Generate all manifests from one source" naively contradicts it. The reconciliation, which is the spine of this design:

> Codegen owns only the **shared/derivable** fields. Everything target-specific remains hand-authorable in a **sparse per-target override** that generation merges last and never clobbers. A plugin that needs a Claude-only field writes it in the override; the toolkit fills the rest.

So the generated manifest = `shared metadata` ⊕ `derived component lists` ⊕ `per-target override` (override wins on conflict). P1 fidelity is preserved; only the boilerplate is generated.

## Single sources of truth

| Fact                                                                                        | Source                                                                                | Notes                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Plugin name                                                                                 | plugin directory basename                                                             | already enforced by `name-consistency`                             |
| Plugin version                                                                              | `aipm.config.ts` `version`                                                            | already exists (spec §9); today re-typed into manifests            |
| description / author / keywords / homepage / repository / license                           | **new optional fields on `aipm.config.ts`** (`defineConfig`)                          | shared across all target manifests                                 |
| skills / agents / commands / hooks paths                                                    | **derived** by scanning `skills/`, `agents/`, `commands/`, `hooks/`                   | override can add/remove entries                                    |
| per-target specifics (e.g. Gemini `contextFileName`, Codex `interface`, Claude-only fields) | **new sparse override file per target** (e.g. `.claude-plugin/plugin.overrides.json`) | hand-authored; merged last                                         |
| marketplace name / owner / description                                                      | **`aipm.workspace.ts`** (`defineWorkspace`, repo root)                                | feeds registry generation; also the embedded design's typed config |

`aipm.config.ts` is the natural home for shared plugin metadata — it already carries `version`. `aipm.workspace.ts` is the natural home for marketplace metadata — it is repo-scoped, made once.

## Generation model

All generation runs in the build phase and reuses primitives that already exist:

- **Sidecar sentinels.** Claude/Codex `plugin.json` schemas are `.strict()`, so a generated manifest cannot carry an in-file `_generated` key. The toolkit already has a **`'sidecar'`** `SentinelMode` (`sentinel.ts`) for exactly this: "strict-schema JSON whose host rejects unknown fields; sentinel lives in a companion `<artifact>.generated` file and the artifact itself is left untouched." Generated manifests use it.
- **Freshness = regenerate-and-byte-compare.** The validator already regenerates `dist/` trees into a temp dir and byte-compares (validate.ts §10.5). Generated manifests/registries get the same treatment: regenerate from sources, compare to the committed bytes, emit a `freshness` finding on any drift or hand-edit.
- **Committed outputs.** Both the generated manifest and its `.generated` sidecar are committed, so in-place GitHub marketplace consumption (hosts read the committed files) keeps working, and diffs stay reviewable. This is the model already used for `hooks/claude.json` and `dist/`.

### Per-target manifests

For each declared target, the generator produces the final manifest by merging, in order:

1. **Shared metadata** from `aipm.config.ts` → mapped to that target's manifest shape (e.g. `version`→`plugin.json.version`, `version`→`POWER.md` frontmatter `version`).
2. **Derived component lists** from a directory scan (`skills/*/SKILL.md` → `skills` paths, etc.), for targets whose manifest declares them (Claude/Cursor/Codex).
3. **The per-target override file** (sparse, hand-authored) — deep-merged last; override keys win.

The result is validated against that target's existing Zod schema (unchanged), then written with a sidecar sentinel.

### Marketplace registries

Generated from `aipm.workspace.ts` metadata + the discovered plugins:

- Claude/Cursor: `{ name, owner, metadata, plugins: [{ name, source, description, tags }] }` (string source).
- Codex: `{ name, interface, plugins: [{ name, source: {source:'local', path}, policy, category }] }` (object source).

`source` is the plugin's repo-root-relative path (honoring a relocated `pluginsRoot` — already the validator's rule after the relocatable-roots work). This **supersedes** the hand-maintained registries: `validateMarketplaceRegistration`'s "is it registered with the right source" check folds into the freshness check (the registry is now generated, so a wrong entry is stale, not a separate finding). The non-envelope-registration guard stays.

### `aipm init --embedded`

Additive scaffolder for an existing software repo (never clobbers): probe for path collisions, then generate `aipm.workspace.ts`, `aipm.repo.ts` (relocated roots if `plugins/`/`dist/` are taken), empty registries, and a non-colliding CI workflow. Automates the guide's manual setup.

## Migration & backward compatibility

- **Opt-in.** A plugin that sets no shared metadata and hand-authors its manifests behaves as today. Generation only activates for plugins that adopt it.
- **The authoring-model shift, made safe.** Once a plugin opts in, its manifests become _generated_ artifacts (the override file is the new authored source). To convert cleanly rather than fight the freshness check, Phase B ships an **extract helper** (a real implementation of the currently no-op `aipm migrate`, or a new `aipm adopt`): it reads a plugin's existing hand-authored manifests, lifts shared fields into `aipm.config.ts`, derives the component lists, and writes the residue into per-target override files — producing byte-identical generated output.
- **`defineConfig` additions are optional** → existing configs stay valid (the `.strict()` schema only gains optional keys).

## Touch points (for the eventual implementation)

- `packages/core/src/config.ts` — extend `AipmConfigInput`/schema with optional shared metadata; add `defineWorkspace`/`AipmWorkspace` (or land it with the embedded Phase 2).
- `packages/core/src/pipeline/build.ts` — new `computeManifestArtifacts` and `computeRegistryArtifacts` (mirroring `computePluginHookArtifacts`/`computeDistBundles`), wired into `runBuild` and the freshness check.
- `packages/core/src/pipeline/validate.ts` — manifests/registries join the freshness sweep; fold the source-correctness half of `validateMarketplaceRegistration` into freshness.
- `packages/core/src/pipeline/sentinel.ts` — already supports `'sidecar'`; no change expected.
- `packages/core/src/targets/<id>/` — a per-target "render manifest from shared+derived+override" function (the inverse of today's `validate`/`schemas`).
- `packages/core/src/pipeline/scaffold.ts` / `init.ts` — scaffold writes override stubs + runs generation; `init --embedded`.

## Phasing (each independently shippable)

- **Phase A — Registry generation.** `aipm.workspace.ts` + generate the three `marketplace.json` files from workspace metadata + discovered plugins; freshness-check them. Smallest, highest-confidence (registries are already toolkit-shaped). Removes the guide's manual step 5. Exit: scaffolding/build emits correct registries with zero hand-editing; freshness catches drift.
- **Phase B — Manifest generation.** Shared metadata on `aipm.config.ts` + derived component lists + per-target overrides → generated manifests with sidecar sentinels; ship the extract/adopt migration helper. Exit: a plugin declaring only shared metadata + content dirs builds valid manifests for every declared target; an existing hand-authored plugin converts via the helper to byte-identical output.
- **Phase C — `aipm init --embedded`.** Generate the full embedded scaffold into an existing repo. Exit: running it in a populated repo produces a buildable, validating marketplace without touching unrelated files.

## Open questions / risks

- **Override file format & location.** Proposed `.<target>-plugin/plugin.overrides.json` (next to where the generated manifest lands) for Claude/Cursor/Codex; for Gemini/Kiro whose manifests aren't under a `.X-plugin/` dir, a sibling `gemini-extension.overrides.json` / `POWER.overrides.md`. Confirm naming before Phase B.
- **Deep-merge semantics** for arrays (component lists): does an override _replace_ or _augment_ the derived list? Proposed: derived by default; an override key replaces that key entirely (predictable, no merge-order surprises).
- **Scaffold interaction.** `aipm scaffold` currently writes hand-authored skeleton manifests; under codegen it should instead write `aipm.config.ts` metadata + override stubs and run generation. Sequencing this so scaffold→build→validate stays clean is a Phase B detail.
- **Freshness vs. marketplace-registration.** Folding registry correctness into freshness changes which `FindingCode` fires for a stale registry (`freshness` instead of `marketplace-registration`). Acceptable, but note it in the changeset (consumer-visible).

## Verification plan (for implementation)

1. **Round-trip parity.** For the `template`'s `skill-evaluator`, run the adopt helper, then `aipm build`, and assert the generated manifests/registries are byte-identical to the current committed ones (spec-first: the _correct_ output is today's hand-authored files).
2. **Drift detection.** Hand-edit a generated manifest → `aipm validate` emits a `freshness` finding; regenerate → clean.
3. **Override fidelity.** Add a Claude-only field via override → it survives generation; a shared field set in `aipm.config.ts` → appears in all target manifests.
4. **Embedded end-to-end.** `aipm init --embedded` in a populated temp repo → `scaffold` → `build` → `validate` all clean, with relocated roots.
5. **Backward compat.** A plugin with no shared metadata and hand-authored manifests still builds/validates unchanged.
