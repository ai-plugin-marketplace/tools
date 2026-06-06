# Scaffold refresh & marketplace-repo upgrade (`aipm init --refresh`)

## Motivation

A marketplace/consumer repo (the `template`, or any repo created by `aipm init`) carries
**toolkit-owned scaffold files** — chiefly `.github/workflows/ci.yml` — whose canonical content
lives in the toolkit's `init-template.ts` render functions. Today there is no way to refresh those
files when the toolkit evolves: they must be hand-edited in lockstep, and they drift. (`.gitignore`
is also seeded by `init`, but it is **not** refresh-managed — see the file-ownership table — because
users legitimately extend it.) Two concrete symptoms:

1. **Drift.** The `template`'s `ci.yml` (node 24, branch filters, a freshness `git status` step) has
   diverged from what `aipm init` renders (node 20, no freshness step) — two representations of the
   same file that disagree.
2. **A latent bug.** `init` pins **both** `@ai-plugin-marketplace/cli` and `core` to
   `^${coreVersion()}`. Since `init` lives in `core`, that now yields `cli ^0.2.0` — a version that
   does not exist on npm (cli is `0.1.1`). `aipm init` currently produces an **uninstallable** repo.
   No test catches it because nothing exercises `init`'s output against reality.

The fix is one command that re-renders toolkit-owned scaffold files from the **installed** tooling,
safely, in place. Designed well, the same command is **the upgrade path for any marketplace repo**:
after `pnpm up @ai-plugin-marketplace/*`, run it to bring the repo's scaffold up to the new
tooling's conventions. The `template` is simply its first consumer.

## The command

`aipm init --refresh [--force]`

- **`aipm init <dir>`** (unchanged): greenfield scaffold; refuses a non-empty directory.
- **`aipm init --refresh`** (new): run inside an existing repo. Re-renders each toolkit-owned
  scaffold file from the installed tooling and updates it **only when safe** (see Conflict model).
  Never touches plugins, authored docs, repo identity, or `aipm build` output.
- **`--force`**: overwrite toolkit-owned files even when the on-disk content diverges from what the
  toolkit last wrote (i.e. the user edited them). Reports each overwrite.

`aipm init --refresh` is the engine; a later `aipm upgrade` alias may front it for discoverability.
This is distinct from `aipm migrate` (schema/breaking migrations), which stays separate.

## File ownership — what refresh manages

| File / area                                               | Managed by refresh? | Why                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                | **Yes**             | Pure tooling recipe; should track the toolkit.                                                                                                                      |
| `.gitignore`                                              | **No**              | Seeded by `aipm init` (comprehensive baseline incl. `.env*`); user owns it thereafter — users extend it freely, so refresh must not clobber or perpetually flag it. |
| `package.json` **dependencies**                           | **No**              | Version bumps are `pnpm up`'s job + lockfile. (Future work: refresh could _report_ when pinned `cli`/`core` drift from the rendered pins; not implemented yet.)     |
| `package.json` other fields                               | **No**              | User owns `scripts`, added deps, etc.                                                                                                                               |
| `aipm.workspace.ts`                                       | **No**              | Repo identity (marketplace name/owner/description) — authored.                                                                                                      |
| `README.md`, `CONTRIBUTING.md`                            | **No**              | Authored prose.                                                                                                                                                     |
| `plugins/**`                                              | **No**              | User content.                                                                                                                                                       |
| Registries, `dist/`, root Gemini/Kiro emission, hook JSON | **No**              | Owned by `aipm build`, freshness-checked separately.                                                                                                                |

The managed set is intentionally small: the files that are _pure tooling recipe_ and break or rot
when they lag the toolkit.

## Conflict model — sidecar + content-hash guard

Reuses the established `.aipm/` pattern (root emission already tracks toolkit-owned paths in
`.aipm/generated-root.json` and refuses to overwrite content it does not own).

- A new sidecar **`.aipm/scaffold.json`** records, for each managed file, the path and a hash of the
  **exact content the toolkit last wrote**:
  ```json
  { "version": 1, "files": [ { "path": ".github/workflows/ci.yml", "hash": "sha256-…" }, … ] }
  ```
- `aipm init` (greenfield) writes the managed files **and** seeds `.aipm/scaffold.json` with their
  hashes.
- `aipm init --refresh` decision, per managed file:

  | On-disk state                                                     | Action                                                                                                                                                                     |
  | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | hash matches sidecar (untouched since last toolkit write)         | Re-render; if content changed, overwrite and update the sidecar hash. Report "updated".                                                                                    |
  | hash differs from sidecar (user edited it)                        | **Skip**; report a conflict with the path. `--force` overwrites and updates the hash.                                                                                      |
  | file missing                                                      | Re-create from the render; update the sidecar. Report "recreated".                                                                                                         |
  | no sidecar entry / no sidecar at all (repo predates this feature) | **Bootstrap:** if current content already equals the new render, adopt it (write the sidecar hash, no diff). Otherwise treat as diverged — skip + report unless `--force`. |

The bootstrap path is what lets an existing repo (e.g. the `template`, or a user upgrading from older
tooling) adopt the mechanism: an unmodified old render that differs from the new one surfaces as a
reviewable conflict the user resolves with `--force` (after reading the diff — the point of an
upgrade). _(Future enhancement: ship known historical render hashes so unmodified old renders
auto-adopt without `--force`.)_

## Prerequisite fix — `init` version pinning

`init` must render the cli and core deps **independently** (they can skew):

- `cli` dep → `^<cliVersion>`, where the cli version is read by the cli entrypoint (it already reads
  its own `package.json`) and passed into `runInit` via `InitOptions.cliVersion`.
- `core` dep → `^<coreVersion>` (read as today, from core's `package.json`).

This yields `cli ^0.1.1` + `core ^0.2.0` — installable, and matching the template. The stale
"§9.1 lockstep" doc comments in `init.ts`/`init-template.ts` are corrected.

## Bringing `init`'s renders to canonical content

So refresh produces the right files, `init-template.ts` is updated to render the canonical
versions:

- `ci.yml`: port the template's workflow (node 24, push/PR on `main`, `pnpm install --frozen-lockfile`
  → `aipm build` → freshness `git status` gate → `aipm validate`; pnpm version from
  `package.json#packageManager`).
- `package.json`: add `packageManager: "pnpm@<pinned>"` (a named constant), correct version pins.
- `.gitignore`: comprehensive baseline — ignores `.env*` (so secrets can't be committed from a fresh
  scaffold), `*.log`, `coverage`, common caches, `scratch/`, plus `node_modules/`, `*.tsbuildinfo`,
  `*.local.*`, and `.DS_Store`. Deliberately does **not** ignore `dist/` (committed build output).
  Seed-only — `init` writes it, the user owns it thereafter (it is not in the refresh-managed set).
- Greenfield `init` keeps its existing registry/`README` behavior: it still seeds empty
  hand-authored registries (`{ "plugins": [] }`) and a simple starter `README.md`, and does **not**
  emit `aipm.workspace.ts`. This keeps a fresh repo `validate`-clean without coupling `init` to the
  registry generator; `aipm.workspace.ts` is opt-in (the `template` demonstrates it). _(A future
  change could have `init` emit `aipm.workspace.ts` + generated registries, but that is out of scope
  here and unrelated to refresh, which manages neither.)_

## CLI surface & output

```
aipm init [dir]              Greenfield scaffold (refuses non-empty dir).
aipm init --refresh          Refresh toolkit-owned scaffold files in an existing repo.
aipm init --refresh --force  Also overwrite files the user has modified.
```

Refresh prints a per-file summary — one line per managed file with its status (`updated` /
`recreated` / `unchanged` / `conflict` / `overwritten`) — and, when any file is a conflict, a note
pointing at `--force`. Exit is `0` even with conflicts (they are reported, not failures, so the
command is script-safe). _(A dependency-drift note comparing `package.json`'s pinned `cli`/`core`
to the rendered pins is possible future work; not implemented.)_

## Backward compatibility

- `aipm init <empty-dir>` is unchanged except for the corrected version pins, the added
  `packageManager` field, the canonical CI-workflow render, and the comprehensive (seed-only)
  `.gitignore`. It still seeds the empty registries and starter `README.md` as before.
- It additionally seeds the `.aipm/scaffold.json` refresh sidecar.
- `--refresh` is purely additive.
- The `.aipm/scaffold.json` sidecar is additive and ignored by older tooling.

## Testing

- **Unit:** the hash-guard decision table (match / diverged / missing / no-sidecar bootstrap),
  pure over injected file state. Negative cases: diverged-without-force skips; `--force` overwrites.
- **Version-skew regression:** assert `init` pins `cli` to `cliVersion` and `core` to `coreVersion`
  independently, and that the cli pin is never a nonexistent same-as-core version.
- **UAT (temp dir):** `aipm init` into a temp dir → assert installable/expected files + sidecar;
  mutate a managed file → `--refresh` reports a conflict and leaves it; `--refresh --force`
  overwrites; bump the rendered content → `--refresh` updates a pristine file and the sidecar hash.
- **Template sync (dev-machine, opt-in):** with a local template checkout, `aipm init --refresh`
  produces no diff (template already in sync). No cross-repo CI gate.

## Out of scope

- Schema/breaking migrations (`aipm migrate`).
- Bumping `package.json` dependency versions (that's `pnpm up`).
- Managing README/CONTRIBUTING or any authored content.
