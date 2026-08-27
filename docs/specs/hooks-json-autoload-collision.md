# DRAFT (not an accepted spec) — `hooks/hooks.json` vs. Claude Code's auto-load

**Status:** Decision document. Nothing here is implemented.
**Audience:** Mike, to pick a resolution.
**Date:** 2026-08-25
**Companion change:** `architecture.md` §10.1.5 + `targets/claude/validate.ts` (the _guard_, already
implemented) — this document is about the _root cause_ that guard papers over.

---

## 1. The collision

Claude Code auto-loads `<pluginDir>/hooks/hooks.json` when that file exists. Per the
[plugins reference](https://code.claude.com/docs/en/plugins-reference), the Hooks component's
location is "`hooks/hooks.json` in plugin root, or inline in plugin.json", and the manifest `hooks`
field names only _additional_ hook config files. Naming the auto-loaded file in the manifest is a
hard error:

```
Duplicate hooks file detected … The standard hooks/hooks.json is loaded automatically,
so manifest.hooks should only reference additional hook files.
```

aipm's artifact model was designed before this auto-load existed. It treats `hooks/hooks.json` as a
_non-Claude_ artifact:

| Spec                                                 | What it says about `hooks/hooks.json`                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `adapter-system.md` D6                               | Codex's plugin-bundled hook artifact is `hooks/hooks.json` **or** `hooks/codex.json`                      |
| `cursor-hooks-target.md` §1                          | `gemini` → `hooks/hooks.json` (PascalCase → snake_case matchers)                                          |
| `embedded-marketplaces-and-codex-target.md` §"Hooks" | "Reuse existing `hooks/hooks.json` generation" for Codex                                                  |
| `open-plugins-target.md` §2.2, OP-D13                | `hooks/hooks.json` is the fixed default location, and is called a **shared** Claude/Cursor/Codex artifact |

The last row is the sharpest dissonance: OP-D13 asserts Claude _shares_ `hooks/hooks.json`. That is
now true in a way the spec did not intend — Claude reads it **unconditionally and for free**, and
errors if you also declare it.

### 1.1 What actually happens today (shipped code)

`computePluginHookArtifacts` (`packages/core/src/pipeline/build.ts`, ~L149–175) writes
`<pluginDir>/hooks/hooks.json` on exactly one condition: **`gemini` is in the envelope**, with
Gemini-dialect content (snake_case tool matchers). Codex emits no hook artifact at all today
(`build.ts` ~L885: "codex / vercel emit no mechanical build output").

So the real, present-day failure is:

- **`claude` + `gemini`** — Claude Code silently auto-loads a **Gemini-format** document as Claude
  hooks. No error is raised by aipm; matchers don't match; behavior is wrong-by-default and quiet.
  If the author also points the Claude manifest at it, Claude refuses to load the plugin.

### 1.2 What happens the moment the specs are implemented as written

- **`claude` + `codex`** — D6 / embedded-marketplaces say Codex reuses `hooks/hooks.json`, whose
  content is Claude-identical (verified in `adapter-system.md` §4.2.1: Codex's event names and stdin
  envelope are identity-passthrough from Claude). Claude then loads that file **and**
  `hooks/claude.json` via the manifest → **every hook fires twice**.
- **`claude` + `open-plugins`** — same shape; §2.2 fixes the location.

The §10.1.5 guard catches the _loud_ variant (duplicate manifest reference). It does not catch the
quiet ones (wrong-dialect auto-load, double-load from two files with identical content).

---

## 2. The binding constraint

The hosts do not have symmetric freedom, and this is what decides the answer.

| Target         | Install mode (`adapter-system.md` D3) | Where the host reads hooks                                                                                                                        |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini`       | **emitted**                           | `dist/gemini/<plugin>/hooks/hooks.json` — already written independently by `targets/gemini/bundle.ts` L149–161, straight from `hooks/claude.yaml` |
| `kiro`         | **emitted**                           | n/a (no hooks)                                                                                                                                    |
| `claude`       | source                                | auto-loads `<pluginDir>/hooks/hooks.json`; manifest may name _extra_ files                                                                        |
| `codex`        | source                                | `<pluginDir>/hooks/hooks.json` **in place**, or a manifest `hooks` path                                                                           |
| `cursor`       | source                                | `<pluginDir>/hooks/cursor.json` via manifest (own dialect — not part of this collision)                                                           |
| `open-plugins` | source                                | `<pluginDir>/hooks/hooks.json` in place (spec default); manifest `hooks` path field also exists                                                   |

Two consequences:

1. **Gemini's in-plugin-dir `hooks/hooks.json` is dead weight.** Gemini is emitted-installed; it
   reads the dist bundle, and the bundler generates its own copy from the YAML source. The file that
   is actually poisoning Claude today is read by _nobody_.
2. **Codex and Open Plugins cannot be moved to `dist/`.** D3 is normative: a host is
   emitted-installed only when it needs a structural restructure of the plugin set (the
   single-artifact hosts). Codex and Open Plugins are source-installed by design, so any resolution
   for them must live inside the plugin directory.

---

## 3. Options

### Option 1 — Per-host hook file names; never emit `hooks/hooks.json`

`hooks/claude.json`, `hooks/codex.json`, `hooks/cursor.json`, `hooks/gemini.json`; every host is
wired via its manifest `hooks` field.

- **Pro:** total explicitness; no host ever picks up a file by accident; matches the existing
  per-host sidecar pattern (`hooks/codex.json`, `agents/openai.yaml`) already blessed by D3/§4.2.
- **Con:** abandons the _documented default location_ for two hosts. Codex supports a manifest
  `hooks` field, and the Open Plugins manifest has a `hooks` component-path field
  (`open-plugins/schemas.ts:144`), so this is mechanically possible — but for Open Plugins it means a
  spec-conformant plugin that deliberately declines the spec's zero-config default, which reads as
  drift and invites future conformance findings against ourselves.
- **Con:** three byte-identical Claude-dialect files in the tree (`claude.json` ≡ `codex.json` ≡
  what `hooks.json` would be), because Claude→Codex is identity-passthrough. Pure duplication.
- **Con:** a stale, hand-added `hooks/hooks.json` still gets auto-loaded by Claude. The rule is
  "never emit it", not "it can't exist" — needs a separate guard anyway.

### Option 2 — Emit the shared artifact only into `dist/` bundles

- **Pro:** correct and free for Gemini — already the case.
- **Con:** does not resolve anything for Codex or Open Plugins, which are source-installed. Applying
  it to them would require flipping their install mode, which D3 forbids. As a _whole-problem_
  answer this option does not exist; as a _scoped_ answer for the emitted-installed hosts it is
  strictly right (and is folded into the recommendation below).

### Option 3 — Suppress the in-plugin `hooks/hooks.json` when `claude` is in the envelope

- **Pro:** smallest diff; removes the collision by construction.
- **Con (disqualifying):** it makes one target's artifact set depend on an unrelated target's
  presence. `claude` + `codex` is the _common_ envelope, and this silently deletes Codex's hooks
  from it — trading a loud error for a quiet capability loss. It also breaks compositionality: the
  freshness check, `add-target`, and `envelope-adherence` all assume adding a target only _adds_
  artifacts. Recommend rejecting.

### Option 4 (proposed) — Make `hooks/hooks.json` the canonical _Claude-dialect_ shared artifact, and drop the Gemini in-tree copy

Two independent parts.

**4a — Stop writing `<pluginDir>/hooks/hooks.json` for the `gemini` envelope.**
Gemini reads `dist/gemini/<plugin>/hooks/hooks.json`, which `gemini/bundle.ts` already produces from
`hooks/claude.yaml`. Delete the in-plugin-dir emission from `computePluginHookArtifacts`. This is a
small, self-contained change and it eliminates the only collision that exists in shipped code.

**4b — Promote the Claude-dialect artifact from `hooks/claude.json` to `hooks/hooks.json`, and stop
referencing it from any manifest.**
The Claude dialect _is_ the shared dialect for Claude + Codex + Open Plugins — `adapter-system.md`
§4.2.1 verified empirically that a Claude handler runs unchanged under Codex, and Open Plugins fixes
the same location. So emit exactly one file at the path all three hosts already look at by default:

- Claude auto-loads it. Manifest carries **no** `hooks` field → §10.1.5 can never fire for
  toolkit-generated output.
- Codex reads it in place at its documented default → D6's "or `hooks/codex.json`" branch is never
  needed, and no Codex manifest plumbing is required.
- Open Plugins gets §2.2's default location with zero configuration, and OP-D13's "shared artifact"
  framing becomes _true_ rather than accidental.
- Cursor keeps `hooks/cursor.json` (genuinely different dialect + controller shim) — unchanged.
- Gemini keeps its dist-only copy — unchanged after 4a.

Net: one Claude-dialect hook file instead of two-to-three, emitted unconditionally whenever a plugin
authors `hooks/claude.yaml`, independent of envelope. Fully compositional.

**Costs / risks of 4b:**

- `hooks/claude.json` is a committed, published generated artifact in template plugins. Retiring it
  is a breaking change: needs a major-ish changeset, a `migrate` step (or at minimum a hard finding
  telling authors to delete the stale file), and a template-repo PR.
- Any author-authored Claude manifest currently containing `hooks: "./hooks/claude.json"` must have
  that field removed. The §10.1.5 guard should be widened to also flag a manifest reference to the
  _toolkit-generated_ `hooks/claude.json` once it is retired.
- `validateHooksFile` currently schema-checks `hooks/claude.json` only. Under 4b it must check
  `hooks/hooks.json` against `claudeHooksFileSchema` — which is independently valuable, because
  Claude will auto-load whatever sits there regardless of who wrote it.
- Requires re-verifying that Codex genuinely auto-discovers `hooks/hooks.json` without a manifest
  reference (D6 says "or the `hooks` manifest field"; the no-manifest path should be confirmed on a
  current `codex` CLI before committing).

---

## 4. Recommendation

**Adopt Option 4, staged.**

1. **Now (low risk, no breaking change): 4a.** Drop the in-plugin-dir `hooks/hooks.json` emission
   for the `gemini` envelope. It is read by no host, and it is the entire cause of the
   claude+gemini wrong-dialect auto-load. Add an `envelope-adherence`/host-contract finding for a
   _stray_ `hooks/hooks.json` that the toolkit did not generate, so a hand-added one can't quietly
   reappear. Update `cursor-hooks-target.md` §1's artifact table and `adapter-system.md` D6.

2. **Next (breaking, its own change): 4b.** Rename the Claude-dialect artifact to
   `hooks/hooks.json`, remove the manifest `hooks` reference from the scaffold and template plugins,
   move `validateHooksFile`'s schema check onto the new path, and reconcile `adapter-system.md` D6,
   `embedded-marketplaces-and-codex-target.md` §Hooks, and `open-plugins-target.md` OP-D13 in the
   same change. Gate on re-verifying Codex's no-manifest auto-discovery.

**Reject Option 3** outright (envelope-coupled artifact sets, silent Codex hook loss). **Prefer 4
over 1** because Option 1 buys explicitness by shipping three byte-identical copies of the same
document and by opting out of two hosts' documented defaults; the empirical Claude↔Codex
identity-passthrough result means the duplication has no semantic justification. If Codex's
no-manifest discovery fails verification, **Option 1 is the correct fallback** — at that point the
default location genuinely cannot serve two hosts and explicit per-host naming is the honest answer.

---

## 5. Open verify-tasks

- **VT-A.** Does Codex auto-discover `<pluginDir>/hooks/hooks.json` with no manifest `hooks` field?
  (Blocks 4b.)
- **VT-B.** Does Claude Code's auto-load resolve `hooks/hooks.json` case-sensitively, and does it
  reject a non-Claude-dialect document loudly or silently? (Determines whether 4a alone is
  sufficient as a stopgap.)
- **VT-C.** Do current Open Plugins hosts honor a manifest `hooks` path that points away from the
  §2.2 default? (Only needed if Option 1 becomes the fallback.)
