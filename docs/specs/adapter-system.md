# ai-plugin-marketplace — Adapter System Specification

**Status:** Draft
**Spec version:** 0.1.0 (new)
**Last updated:** 2026-06-17
**Scope:** A per-target adaptation layer for **shared authored content** (skills, agents, hook sources) in `@ai-plugin-marketplace/core`, and the install-model change that lets adapted output reach hosts that install from source. Companion to `architecture.md` (§2 principles, §6 envelope, §7 mechanical transformations) and `dogfood-marketplace-and-native-install.md` (the single-artifact-host gate and the shelved `aggregate` opt-in this spec fills in).

> **Note to future readers.** This spec proposes a deliberate evolution of governing principles **P2** ("no automatic adaptation from one target to another") and **P4** ("cross-target translation is forbidden"). It does not discard them — it draws a sharper line that keeps their anti-quadratic, anti-lossy intent while admitting the one form of adaptation that author-once distribution actually needs. Read §2 before §4.

---

## 1. Purpose and scope

### 1.1 Why this exists

The toolkit's promise is *author once, distribute to the harnesses we care about*. Today that promise is honored by **faithful mechanical projection** (§7) plus **omission** of anything a target can't take (P2). Two realities make omission insufficient:

1. **A valid skill silently fails to load on a stricter host.** Claude Code's frontmatter parser is lenient; Codex's strict-parses and enforces a key allowlist (`{name, description, license, allowed-tools, metadata}`), bans `<`/`>` in `description`, and rejects malformed YAML. A `SKILL.md` that is correct and useful on Claude (e.g. carrying `arguments:` or `user-invocable:`) **does not load on Codex** — author-once is hollow if the one artifact can't satisfy both. (Evidence: `liaison` failed to load on Codex with `invalid YAML: mapping values are not allowed`; `code-review`/`dotfiles`/`dream` carry keys outside Codex's allowlist.)
2. **Single-artifact hosts can't represent a multi-plugin marketplace.** Gemini and Kiro install one extension/power per repo (`dogfood-marketplace-and-native-install.md` §3). A 12-plugin marketplace has no representation on those hosts at all — they are dropped entirely, not merely degraded.

The fix for both is the same shape: **adapt the shared authored content per target** — rewriting or restructuring it as far as the target's contract requires — rather than only projecting-or-omitting.

### 1.2 What this is

A bounded **adapter layer** that takes **shared authored content** and emits a per-target version that satisfies that target's contract:

- **Shared authored content** = `skills/**/SKILL.md`, `agents/*.md`, `commands/*.md`, and the hook source (`hooks/claude.yaml`). One authored file serves multiple targets.
- An **adapter** is a pure, lookup/rule-driven function `adapt(sharedContent, target) → targetContent` plus a set of **adaptation findings** describing every change it made.

### 1.3 What this is not (non-goals)

- **Not cross-target translation.** No adapter reads target A's *native manifest* to synthesize target B's. P1's per-target native manifests (`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `gemini-extension.json`, `POWER.md`) remain hand-authored and untouched by this layer. See §2.2.
- **Not lossy guesswork.** Every adaptation is deterministic and table/rule-driven (§2.3). Where a faithful adaptation is impossible, the adapter **fails with a finding**, it does not approximate.
- **Not a quality evaluator.** Whether an adapted skill *works well* on a host is the job of a future eval harness (`architecture.md` §8.3 future packages), out of scope here. This layer only makes a skill **loadable/installable**.

---

## 2. Governing decisions (reconciling P2 and P4)

### 2.1 The sharper line

> **D1 (normative).** Adaptation is permitted **only** as a **source→target** projection of *shared authored content*, and **only** when it is deterministic and rule-driven (§2.3). **Target→target** translation remains forbidden (P4 unchanged).

This is the load-bearing distinction. P4's quadratic-complexity fear is about `N×N` translations between target *manifests* (Claude hook → Kiro hook). Adapters are `N` projections from a single shared source — **linear in targets**, one adapter per target, each blind to every other target's output. Adding a target adds one adapter, never a translation matrix.

> **D2 (normative).** P2 is relaxed *for shared authored content only*. The envelope (§6) still governs *which* targets a plugin emits; the adapter governs *how* the shared content is shaped for each declared target. There is still **no** inference of one target's native manifest from another's.

### 2.2 What adapters may and may not touch

| Content | Authored | Adapted per target? |
| --- | --- | --- |
| `skills/**/SKILL.md` | once (shared) | **Yes** — frontmatter adapter (§4.1) |
| `agents/*.md`, `commands/*.md` | once (shared) | **Yes** — frontmatter adapter (§4.1) |
| `hooks/claude.yaml` | once (shared) | **Yes** — hooks adapter (§4.2), generalizing §7.2 |
| `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `POWER.md` | per-target (native, P1) | **No** — hand-authored, never synthesized |

### 2.3 Adaptation stays "mechanical" (extends §7.1)

§7.1 defines *mechanical* as "a pure function driven by a committed lookup table, bounded to a single target." Adapters meet this bar, with one widening: a mechanical transformation today is **lossless**; an adapter MAY **drop or relocate** content **iff** the rule is a committed table and the drop/relocation is reported as a finding (§5). It remains pure, bounded to one target, and inspectable as data.

> **Design note.** This is the whole risk surface. The guardrail is §5: an adapter that silently drops content is a bug. An adapter that drops content *and says so* preserves P5's "honest diffs" in a new form — the committed `dist/` is honest about what was adapted away.

---

## 3. Install model: source-installed vs emitted-installed targets

### 3.1 The two install modes

A target installs a plugin in one of two modes:

- **Source-installed** — the target's marketplace registry points at the plugin **source** directory (`./plugins/<name>`). The host reads the authored files directly. *Today:* `claude`, `cursor`, `codex` (`.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/` registries all reference `./plugins/<name>`).
- **Emitted-installed** — the registry/root artifact points at a toolkit-**emitted** copy under `dist/<target>/<plugin>/`. *Today:* `gemini`, `kiro`.

### 3.2 The linchpin rule

> **D3 (normative).** A target that requires any non-empty adaptation of shared content **MUST** be emitted-installed for the adapted plugins; its registry **MUST** point at the emitted copy, never at the source. A target whose contract the authored source already satisfies MAY remain source-installed.

**Consequence.** A frontmatter adapter cannot reach a source-installed host, because the host reads the same authored `SKILL.md` as every other source-installed host — there is only one file to read. To give **Codex** adapted frontmatter, Codex **graduates to emitted-installed**: `aipm build` emits `dist/codex/<plugin>/` with the adapted `SKILL.md`, and `.agents/plugins/marketplace.json` points there.

> **Open question (OQ-1).** Do `claude` and `cursor` ever need adaptation, or do they stay source-installed permanently? Current evidence: their parsers are lenient, so the authored source satisfies them and they stay source-installed. If a future Claude/Cursor contract tightens, D3 promotes them the same way. The spec does not pre-emptively promote them.

### 3.3 Per-target install mode (target state)

| Target | Install mode | Adapts shared content? |
| --- | --- | --- |
| claude | source | no (lenient) |
| cursor | source | no (lenient) |
| codex | **emitted (new)** | **yes** — frontmatter (§4.1) |
| gemini | emitted | yes — frontmatter + unifier (§4.3) |
| kiro | emitted | yes — frontmatter + unifier (§4.3) |
| vercel | emitted | yes — frontmatter |

> **Expected artifact.** After build, `.agents/plugins/marketplace.json` entries reference `./dist/codex/<plugin>` (not `./plugins/<plugin>`), and `dist/codex/<plugin>/skills/**/SKILL.md` differs from the source `SKILL.md` only by the adaptations §4.1 lists, each backed by a finding.

---

## 4. The adapter classes

### 4.1 Frontmatter adapter

**Input:** a shared `SKILL.md` / `agents/*.md` / `commands/*.md` frontmatter block (already valid YAML — the hard `frontmatter-invalid` check from `validate.ts` runs first and gates this).
**Output:** a frontmatter block satisfying the target's contract.
**Per-target contract table** (committed; the rule data D2/§2.3 require):

| Rule | claude/cursor (source) | codex | gemini | kiro |
| --- | --- | --- | --- | --- |
| Allowed top-level keys | (lenient; unchanged) | `{name, description, license, allowed-tools, metadata}` | host table | host table |
| Disallowed key handling | n/a | **relocate** under `metadata` (default) or **drop** (per OQ-2) | per host | per host |
| `<`/`>` in `description` | unchanged | **escape/strip** (per OQ-3) | per host | per host |
| `name` regex / length | unchanged | `^[a-z0-9-]+$`, ≤64 | same | same |
| `description` length | unchanged | ≤1024 | ≤1024 | ≤1024 |

**Worked example (codex).**

```yaml
# authored SKILL.md (serves all targets)
---
name: dream
description: "Consolidate memory and surface customization opportunities."
arguments:            # Claude-meaningful, NOT in Codex's allowlist
  - name: scope
    required: false
user-invocable: true  # Claude-meaningful, NOT in Codex's allowlist
---
```

```yaml
# dist/codex/dream/skills/dream/SKILL.md  (adapted)
---
name: dream
description: "Consolidate memory and surface customization opportunities."
metadata:
  arguments:
    - name: scope
      required: false
  user-invocable: true
---
```

> **Why this example matters.** It shows the default disallowed-key strategy (**relocate under `metadata`**, which Codex's allowlist permits) preserving the information while satisfying the contract — and it shows that the authored source is unchanged (Claude still reads top-level `arguments`/`user-invocable`).

> **Open question (OQ-2).** Default to **relocate-under-`metadata`** or **drop**? Relocate preserves data but Codex won't *act* on `arguments` nested in `metadata` (it just tolerates it). Drop is simpler but loses the record. Recommendation: relocate (lossless + reported); allow per-plugin override later.
> **Open question (OQ-3).** Angle brackets in `description`: escape (`&lt;`), strip, or fail-with-finding? Recommendation: fail-with-finding (a human-readable description rarely *needs* `<`; forcing the author to rewrite keeps the description natural on every host). Not yet runtime-fatal on Codex, so severity is **soft** initially (§5).

### 4.2 Hooks adapter

Generalizes the existing §7.2 hook transforms (`claude.yaml` → claude/codex/gemini JSON) into the adapter framework: same per-target tool-matcher + event-name tables, now emitting into the per-target `dist/<target>/<plugin>/` tree for emitted targets and reporting any dropped event/matcher (Codex lacks `SessionEnd`/`Notification`; Gemini drops tools with no equivalent) as findings rather than silent omission. No new translation is introduced — this is a packaging-location and reporting change over shipped behavior.

### 4.3 Structural unifier (the `aggregate` opt-in)

Fills the seam `dogfood-marketplace-and-native-install.md` reserves: *"Merging N→1 into a single artifact is shelved as a future `aggregate` opt-in."*

**Problem.** Gemini/Kiro install one artifact per repo; a multi-plugin marketplace currently emits **zero** Gemini/Kiro artifacts (the `single-artifact-host` hard finding fires when >1 plugin declares the host).
**Adapter.** When `aggregate` is opted in for a single-artifact host, the unifier **merges every declaring plugin's shared content into one host artifact**: one `gemini-extension.json` (resp. `POWER.md`) at the repo root whose `skills/`, `agents/`, `commands/` are the **namespaced union** of all plugins' skills.

> **D4 (normative).** Under `aggregate`, skill/agent names in the unified artifact MUST be made collision-free by a committed namespacing rule (proposed: `<plugin>__<skill>`); a collision the rule cannot resolve is a **hard** finding, not a silent overwrite.

> **Expected artifact.** A 12-plugin marketplace with `aggregate: ['gemini', 'kiro']` emits one `dist/gemini/<marketplace>/` containing all ~N skills (namespaced) and one root `gemini-extension.json` — recovering Gemini/Kiro distribution that the N=1 gate otherwise forbids.

> **Open question (OQ-4).** Namespacing scheme and how the unified extension's single `name`/`description` is derived (from `aipm.workspace.ts`? a designated "primary" plugin?). Deferred to the unifier design pass.

---

## 5. Honesty and diagnostics (preserves P5)

> **D5 (normative).** Every adaptation that **drops, relocates, escapes, or merges** content MUST emit a `Finding`. Adapters never change content silently.

Proposed new `FindingCode` values (additive to the typed union, per `architecture.md` 0.4.0 contract):

| Code | Severity | When |
| --- | --- | --- |
| `frontmatter-adapted` | soft | a disallowed key was relocated/dropped, or `<`/`>` handled, for a target |
| `frontmatter-unadaptable` | hard | a contract violation no rule can fix (e.g. `name` too long) — the author must fix the source |
| `hook-adapted` | soft | an event/matcher was dropped for a target |
| `unifier-collision` | hard | two plugins' skills collide under the namespacing rule |

The committed `dist/<target>/` trees plus these findings keep diffs honest: a reviewer sees both the adapted bytes and the reason.

---

## 6. Edge cases and exceptions

- **Adaptation is a no-op.** If the authored source already satisfies a target's contract, `adapt()` returns it unchanged and emits no finding. A target whose plugins all no-op MAY stay source-installed (D3).
- **`frontmatter-invalid` precedes adaptation.** Malformed YAML is a hard stop (existing check); the adapter never runs on unparseable frontmatter.
- **Idempotence.** `adapt(adapt(x, t), t) == adapt(x, t)` for every target `t` — required so a re-run of `aipm build` is freshness-stable (P5/§10.5).
- **Envelope still gates emission.** A plugin that does not declare `codex` gets no `dist/codex/` tree regardless of adaptation capability.

---

## 7. Validation and test implications

- **Determinism fixtures.** For each adapter and target, a golden fixture pair `(authored, expected-adapted)` with a structural assertion per rule (not a snapshot) — mirrors the spec-first assertion style: each expected value traces to a contract-table row.
- **Idempotence test.** Assert §6's idempotence law for every adapter/target.
- **Finding coverage.** Each adaptation rule has a test asserting the exact `FindingCode`/severity it emits.
- **Freshness.** The existing CI freshness check (§10.5) extends to `dist/codex/**` once Codex is emitted-installed; a hand-edited adapted file fails CI.
- **Round-trip load test (UAT).** For a representative plugin, install the emitted `dist/codex/<plugin>` into an isolated Codex (`CODEX_HOME` sandbox) and assert the skill loads — the deterministic proxy plus the real-host check used to verify the `frontmatter-invalid` fix.

---

## 8. Deferred / future work

- The **eval harness** (does the adapted skill *work well* on a host) — separate initiative; Anthropic's `run_eval`/grader/benchmark pipeline is the reference model.
- Per-plugin **adapter overrides** (e.g. choose drop vs relocate per skill).
- Promotion of `claude`/`cursor` to emitted-installed (only if their contracts tighten — OQ-1).
- The unifier's name/description derivation and namespacing scheme (OQ-4).

---

## 9. Migration impact

- **Codex graduates to emitted-installed.** `.agents/plugins/marketplace.json` entries change from `./plugins/<plugin>` to `./dist/codex/<plugin>`; `dist/codex/**` becomes committed + freshness-checked. This is a one-time registry + build change, additive to existing targets.
- **No change to `claude`/`cursor`** (stay source-installed) or to any hand-authored native manifest.
- **`aggregate` is opt-in**; existing single-plugin Gemini/Kiro behavior is unchanged when not opted in.

---

## Open questions (consolidated)

- **OQ-1** — Do claude/cursor ever need adaptation, or stay source-installed permanently?
- **OQ-2** — Disallowed frontmatter keys: relocate-under-`metadata` (recommended) vs drop?
- **OQ-3** — Angle brackets in `description`: fail-with-finding (recommended) vs escape vs strip?
- **OQ-4** — Unifier namespacing scheme and unified `name`/`description` derivation.
- **OQ-5** — Should `frontmatter-adapted` checks start **soft** (visibility) and harden to enforce the Codex contract once Codex's *runtime* loader enforces it, or be hard from day one?
