# ai-plugin-marketplace — Adapter System Specification

**Status:** Draft
**Spec version:** 0.3.0
**Supersedes:** 0.2.1 (expanded §4.2 hooks adapter — primary-verified the hook *handler contract* across all three live targets along three axes (event names / stdin envelope / stdout control + exit-code default); established the **observer-vs-controller** tiering; **D6a** Codex identity-passthrough; **D6b** the fail-closed Cursor translation shim for controller hooks; resolved the "is author-once true for hooks?" verify-task — yes for Codex, no for Cursor controllers); 0.2.0 (added §4.5 agent/subagent adapter — verified subagent contracts for Claude/Cursor/Codex from primary docs; the **context-isolation invariant** D11; the companion-skill-bridges-explicit-only-activation model D12); 0.1.0 (first draft — corrected after verifying every per-target claim against each harness's primary docs; the v0.1.0 premise that Codex is frontmatter-strict and must graduate to emitted-install was wrong)
**Last updated:** 2026-06-17
**Scope:** A per-target adaptation layer for **shared authored content** (skills, agents, hook sources) in `@ai-plugin-marketplace/core`. Companion to `architecture.md` (§2 principles, §6 envelope, §7 mechanical transformations) and `dogfood-marketplace-and-native-install.md` (the single-artifact-host gate and the shelved `aggregate` opt-in this spec fills in).

> **Note to future readers.** This spec evolves governing principles **P2** ("no automatic adaptation from one target to another") and **P4** ("cross-target translation is forbidden") — keeping their anti-quadratic, anti-lossy intent while admitting the one adaptation author-once distribution needs. Read §2 before §4.

> **What changed 0.1.0 → 0.2.0.** Every per-target contract claim is now grounded in the harness's own docs, after the agentrc capability matrix proved repeatedly stale (it was wrong about Cursor hooks, Cursor plugins, Codex hooks, Codex user-invocation, and Cursor's skill field set). The biggest correction: **Codex's runtime frontmatter contract is lenient** (`name`+`description` required; extra keys tolerated; angle brackets allowed; only *invalid YAML* is load-fatal). The strict allowlist/angle-bracket rules cited in 0.1.0 come from openai/skills' `quick_validate.py` — a skill-**authoring lint**, not the runtime loader. Consequently: Codex stays **source-installed**; there is no per-host `SKILL.md` rewrite for our current targets; and "adaptation" is mostly **emitting host-native sidecar files** (hooks JSON, `agents/openai.yaml`) into the source tree — the pattern the toolkit already uses for `hooks/codex.json`.

---

## 1. Purpose and scope

### 1.1 Why this exists

Author-once is honored today by **faithful projection** (§7) + **omission** of what a target can't take (P2). Two realities make that insufficient — but **not** the one 0.1.0 assumed (per-host frontmatter rewriting):

1. **Hosts read the same intent from different *locations*.** A skill's agent-vs-user invocation policy lives in `SKILL.md` frontmatter on Claude/Cursor (`disable-model-invocation`) but in a **sidecar `agents/openai.yaml`** (`policy.allow_implicit_invocation`, inverted) on Codex. Hooks live in `hooks/claude.json` on Claude, `hooks/hooks.json` on Codex. Author-once means the toolkit must **emit each host's native sidecar from the shared source** — not omit the capability.
2. **Single-artifact hosts can't represent a multi-plugin marketplace.** Gemini/Kiro install one extension/power per repo (`dogfood-marketplace-and-native-install.md` §3); a 12-plugin marketplace gets **zero** representation there today — dropped, not degraded.

**Explicitly *not* a driver (corrected from 0.1.0):** per-host `SKILL.md` frontmatter rewriting. Claude, Cursor, and Codex are all **lenient at runtime** — they require only `name`+`description` and tolerate unknown keys; the only load-fatal frontmatter defect is **invalid YAML**, which is a *validate-time gate on the source* (`frontmatter-invalid`, already shipped in core 0.5.0), not an adaptation. (Evidence: `liaison` failed to load on Codex purely on a YAML parse error — an unquoted `": "` — not on any key; `dream` loaded fine on Codex carrying `arguments`/`user-invocable`.)

### 1.2 What this is

A bounded **adapter layer**: pure, lookup/rule-driven functions that, from **shared authored content** (`skills/**/SKILL.md`, `agents/*.md`, `commands/*.md`, hook source), emit each declared target's native representation — **and a `Finding` for every change made**. Two shapes:

- **Sidecar emission** (source-installed hosts): generate committed per-host files *in the source plugin dir* (hook JSON, `agents/openai.yaml`). The shared `SKILL.md` is **not** rewritten.
- **Bundle / unify** (emitted single-artifact hosts): assemble `dist/<target>/` bundles; optionally merge N→1 (§4.3).

### 1.3 Non-goals

- **Not cross-target translation.** No adapter reads target A's native manifest to synthesize target B's; the per-target native manifests (P1) stay hand-authored.
- **Not lossy guesswork.** Deterministic, table-driven; where a faithful adaptation is impossible the adapter **fails with a finding**.
- **Not a quality evaluator.** Whether an adapted skill *works well* on a host is a future eval harness (`architecture.md` §8.3), out of scope.
- **Not per-host frontmatter rewriting** for currently-targeted hosts — reserved (§4.4) for a future *runtime-strict* host, none of which we target.

---

## 2. Governing decisions (reconciling P2 and P4)

> **D1 (normative).** Adaptation is permitted **only** as a **source→target** projection of *shared authored content*, and **only** when deterministic and rule-driven (§2.2). **Target→target** translation stays forbidden (P4 unchanged). Adapters are `N` projections from one shared source — linear in targets, each blind to the others — never an `N×N` matrix.

> **D2 (normative).** P2 is relaxed *for shared authored content only*. The envelope (§6) still governs *which* targets emit; the adapter governs *how* the shared content is shaped/located for each. No inference of one target's native manifest from another's.

### 2.1 What adapters may and may not touch

| Content | Authored | Adapted? |
| --- | --- | --- |
| `skills/**/SKILL.md` frontmatter | once (shared) | **Located/lifted** — invocation policy & hooks lifted to host-native sidecars (§4.1); the body and lenient frontmatter pass through unchanged |
| `hooks/claude.yaml` (plugin-level hook source) | once (shared) | **Yes** — per-host hook sidecar (§4.2) |
| `agents/*.md` (Claude-native subagents) | once (shared) | **Yes** — format/field transform + companion skill on explicit-only hosts (§4.5); context isolation is invariant (D11) |
| native manifests (`.claude-plugin/…`, `.cursor-plugin/…`, `.codex-plugin/…`, `gemini-extension.json`, `POWER.md`) | per-target (P1) | **No** — hand-authored, never synthesized |

### 2.2 Adaptation stays "mechanical" (extends §7.1)

§7.1 defines *mechanical* as a pure function driven by a committed lookup table, bounded to one target. Adapters meet this, widened so an adapter MAY **drop, relocate, or merge** content **iff** the rule is committed data and the change is reported as a `Finding` (§5). The committed output keeps P5's "honest diffs" — the bytes plus the reason are both reviewable.

---

## 3. Install model: source-installed vs emitted-installed

### 3.1 The two modes

- **Source-installed** — the target's registry points at the source plugin dir (`./plugins/<name>`); the host reads authored files plus any committed **per-host sidecars** the toolkit emits there (e.g. `hooks/codex.json`, `agents/openai.yaml`). *Today and going forward:* **`claude`, `cursor`, `codex`** — all lenient on the shared `SKILL.md`, all reading host-specific extras from sidecars.
- **Emitted-installed** — the registry/root artifact points at a toolkit-emitted `dist/<target>/` copy. *Today:* **`gemini`, `kiro`**.

### 3.2 When a host must be emitted-installed

> **D3 (normative, revised).** A host MUST be emitted-installed **only** when it needs a *structural restructure of the plugin set* that cannot be expressed as committed sidecars in the source tree — i.e. the **single-artifact hosts** (Gemini/Kiro: one repo-root artifact; the unifier merges N→1). A host that is lenient on the shared files and consumes host-specific extras via sidecars **stays source-installed**.

**Codex stays source-installed** (corrected from 0.1.0): its frontmatter leniency means the source `SKILL.md` works as-is, and its hook config (`hooks/codex.json`) and invocation policy (`agents/openai.yaml`) are committed sidecars in the source dir, exactly like `hooks/codex.json` already is. No `dist/codex/` tree.

| Target | Install mode | What the adapter emits |
| --- | --- | --- |
| claude | source | `hooks/claude.json` |
| cursor | source | hook sidecar (mechanism = **verify task T1**) |
| codex | source | `hooks/codex.json`, `agents/openai.yaml` (invocation policy) |
| gemini | emitted | `dist/gemini/…` bundle(s); unifier if `aggregate` |
| kiro | emitted | `dist/kiro/…` bundle(s); unifier if `aggregate` |

---

## 4. The adapter classes

### 4.1 Invocation-policy adapter (frontmatter → host-native location)

The agent-vs-user invocation controls do **not** live in the same place across hosts (all per primary docs):

| Capability | Claude (`SKILL.md` fm) | Cursor (`SKILL.md` fm) | Codex (`agents/openai.yaml`) |
| --- | --- | --- | --- |
| Disable **agent** auto-invoke | `disable-model-invocation: true` | `disable-model-invocation: true` | `policy.allow_implicit_invocation: false` (**inverted**) |
| Disable **user** invoke (agent-only) | `user-invocable: false` | — none — | — none — |
| Arg hint | `argument-hint` | — none — | — none — |
| User-invoke surface | `/name` | `/` search | `$skill` / `/skills` |

> **D4 (normative).** When the shared `SKILL.md` sets `disable-model-invocation`, the adapter **lifts it to each target's native location**: pass through on Claude/Cursor; emit `agents/openai.yaml` with `policy.allow_implicit_invocation` = **NOT** the source value on Codex. The boolean inversion is the footgun — it MUST be table-encoded, not hand-mapped.

> **D5 (normative).** `user-invocable: false` (a Claude-only "agent-only" control) has no equivalent on Cursor/Codex — both make the skill user-invokable. The adapter emits a soft **`invocation-widened`** finding ("agent-only skill `<name>` is directly user-invokable on `<target>`"). It does **not** try to suppress the skill. `argument-hint` is dropped on hosts that lack it (soft/silent).

> **Why this is a "located", not a "rewritten", adaptation.** The source `SKILL.md` is not edited for Codex (Codex tolerates the extra keys). The adapter *adds* `agents/openai.yaml`. Same shape as hook sidecars.

### 4.2 Hooks adapter

> **D6 (normative).** **Plugin-level hooks are the standard.** These are plugin marketplaces; the plugin is the install/enable unit. The shared hook source (`hooks/claude.yaml`) projects to each host's plugin-bundled hook artifact: `hooks/claude.json` (Claude), `hooks/hooks.json` or `hooks/codex.json` (Codex; verified plugin-bundled), the Cursor equivalent (**verify task T1**). Dropped events/matchers (e.g. a Codex-unsupported event) emit a soft `hook-adapted` finding.

**Verified:** both Codex and Cursor carry hooks **in the plugin construct** (Codex `developers.openai.com/codex/plugins/build.md`: `hooks/hooks.json` or the `hooks` manifest field, but **non-managed — Codex skips them until the user reviews & trusts**; Cursor `cursor.com/docs/plugins`: a plugin may bundle Hooks). So **no global/project agent-install is needed**, and the `## Initial setup` agent-as-runtime polyfill is **reserved** for a genuinely hookless host — we have none.

#### 4.2.1 The hook *contract* is portable for Claude→Codex, divergent for Cursor (primary-verified)

"Author a hook once" splits along the **handler contract**, not the event key. The naive view — rename event keys and reuse the JSON — is correct for Codex and **wrong for Cursor**. Three axes, each cited to the harness's own hook doc ([Claude](https://code.claude.com/docs/en/hooks), [Codex](https://developers.openai.com/codex/hooks), [Cursor](https://cursor.com/docs/hooks)):

| Axis | Claude (source) | Codex | Cursor |
| --- | --- | --- | --- |
| Event names | `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `PreCompact` (**PascalCase**) | **same names** (subset) → **identity** | `preToolUse` / `beforeSubmitPrompt` / `stop` / `sessionStart` (**camelCase**) → rename |
| Stdin envelope | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_output` | **same** + `turn_id`/`model`; `tool_response` for output | **`conversation_id`** (not `session_id`), `generation_id`, `workspace_roots`; shell events use `command`/`output` |
| Stdout control | `decision:"block"`+`reason`; `hookSpecificOutput.permissionDecision` (allow/deny/ask); `continue`; `additionalContext` | **identical** structure | flat **`permission`** (allow/ask/deny), `continue`, `agent_message`, `additional_context` (snake_case, **not** nested) |
| Exit-code default | `2` = blocking error (fail-safe) | `2` = failure (same) | `2` = deny; **other = fail-OPEN** unless `failClosed:true` |

> **Governing distinction — tier by hook *intent*, not by host.**
> - **Observer hook** (side-effect only — log / notify / format-on-save; emits no control JSON, reads at most the common fields): portable to **all three** with **event-rename only**.
> - **Controller hook** (returns `block` / `permission` / `updatedInput`): portable **Claude↔Codex unchanged**; on Cursor the **handler shape itself differs** (different stdin envelope + different stdout control + opposite failure default) — a key rename is not enough.

> **D6a (normative) — Codex is identity-passthrough.** Codex shares Claude's event names, stdin field names (modulo `tool_output`→`tool_response`), stdout control protocol, and exit codes. The adapter emits Codex hooks by **copying the Claude JSON unchanged**, except events with no Codex equivalent (`SessionEnd`, `Notification`) which are **omitted with a `hook-adapted` finding** (never remapped). No handler-code change is required. Committed map: identity over `{SessionStart, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStop, Stop}`; omit `{SessionEnd, Notification}`.

> **D6b (normative) — Cursor controller hooks are served by a generated translation shim.** Because the Cursor handler contract diverges on every axis, the adapter wraps each Claude **controller** hook in a **shim command** that (1) reads Cursor stdin and rewrites it to the Claude envelope (`conversation_id`→`session_id`; for shell events synthesize `tool_name:"Bash"`, `tool_input.command`←`command`; camelCase→PascalCase event); (2) invokes the original Claude handler; (3) translates the Claude control output back to Cursor's (`permissionDecision`→`permission`, `decision:"block"`→`permission:"deny"`/`continue:false`, `updatedInput`→`updated_input`, `additionalContext`→`additional_context`). **Three non-negotiable safety mandates** — Cursor fails open by default and [silently allows on malformed JSON](https://forum.cursor.com/t/beforeshellexecution-hook-malformed-json-response-silently-allows-command-instead-of-blocking/152669): the shim's Cursor hook entry MUST set **`failClosed: true`**; the shim MUST **always emit syntactically valid JSON**; and on any error / missing field / non-zero handler exit the shim MUST emit **`{"permission":"deny"}` and exit `2`** (fail-safe, inverting Cursor's default). Soft `hook-controller-shimmed-cursor`. **Observer** hooks take the event-rename path with no shim.

> Committed Claude→Cursor event map: `PreToolUse→preToolUse`, `PostToolUse→postToolUse`, `UserPromptSubmit→beforeSubmitPrompt`, `Stop→stop`, `SessionStart→sessionStart`, `SessionEnd→sessionEnd`, `PreCompact→preCompact`, `SubagentStart→subagentStart`, `SubagentStop→subagentStop`; omit `Notification`.

> **Cursor cloud/CLI caveat (verified).** Cursor's cloud agents do **not** deliver `sessionStart` / `sessionEnd` / `beforeSubmitPrompt` / `stop` (no VM at those points; some "not yet wired"). A shimmed controller bound to those events **will not fire** on a Cursor cloud agent → soft `hook-event-unsupported-cursor-cli`.

> **D7 (normative).** **Skill-frontmatter hooks** (Claude's `hooks:` block inside a `SKILL.md`, skill-*scoped*) are an **opt-in** authoring path, not the default:
> - **Claude → passthrough** (native skill-scoping preserved).
> - **Codex/Cursor → promote** to the plugin hook artifact (no skill-scoping on those hosts) and emit a soft **`hook-scope-widened`** finding: *"skill-scoped hook `<name>` becomes plugin-wide (always-on) on `<target>`; if it is a blocking/deny gate it will fire outside this skill — confirm intended."*
>
> No hard gate, no `promote:` flag: activation scope is a decision the Claude author already owns; the warning surfaces the footgun and trusts them.

**Documented gaps to carry (not bypass):** (a) Codex's **trust prompt** for plugin-bundled hooks — a security model; surface it in plugin docs. (b) Cursor's plugin-hook **declaration/activation mechanism** is doc-ambiguous — **verify task T1**. (c) whether Cursor honors **`failClosed` in cloud agents** — **T6** (the shim's fail-safe depends on it). (d) shell-event ↔ `Bash`-tool stdin **synthesis fidelity** — **T7**.

### 4.3 Structural unifier (the `aggregate` opt-in)

Fills the seam `dogfood-marketplace-and-native-install.md` reserves (*"Merging N→1 … a future `aggregate` opt-in"*). For single-artifact hosts there are **two** paths:

1. **N separate extensions/powers** — each plugin a separately-installable Gemini extension / Kiro power (per the primary docs, multiple can coexist). Lowest complexity; user installs selectively.
2. **Unify N→1** (`aggregate`) — merge every declaring plugin's skills/agents/commands into **one** repo-root artifact (one `gemini-extension.json` / `POWER.md`).

> **D8 (normative).** Under `aggregate`, names in the unified artifact MUST be made collision-free by a committed namespacing rule (proposed `<plugin>__<skill>`); an unresolved collision is a **hard `unifier-collision`** finding, never a silent overwrite.

### 4.4 Frontmatter *rewrite* adapter — RESERVED [Future, seam reserved]

Per-host rewriting of `SKILL.md` frontmatter (stripping to an allowlist, escaping `<`/`>`) is **not built and not needed** for claude/cursor/codex (all lenient). It is reserved for a future host whose **runtime** loader enforces a strict allowlist or character ban. If such a host is targeted, D3 promotes it to emitted-installed and this adapter rewrites its `dist/<host>/` copy — keeping the source untouched for lenient hosts. Until then, the only frontmatter rule that runs is the existing **validate-time** `frontmatter-invalid` gate on the source.

### 4.5 Agent (subagent) adapter

Subagents (`agents/*.md`, Claude-native) are shared authored content, but they port with **heavier, lossier** adaptation than skills — under one hard invariant.

**Verified per-target subagent contract** (each row from the harness's own docs):

| | Claude `agents/*.md` ([src](https://code.claude.com/docs/en/sub-agents)) | Cursor `.cursor/agents/*.md` ([src](https://cursor.com/docs/context/subagents)) | Codex `.codex/agents/*.toml` ([src](https://developers.openai.com/codex/subagents)) |
| --- | --- | --- | --- |
| Format | MD + YAML frontmatter | MD + YAML frontmatter | **TOML**; prompt in `developer_instructions` (no MD body) |
| Required | name, description | description | name, description, developer_instructions |
| Model tier | sonnet/opus/haiku/fable/id/inherit | inherit/fast/id | model + model_reasoning_effort |
| Tool scoping | `tools` + `disallowedTools` (PascalCase) | none (only `readonly`) | none (governed by `sandbox_mode` + `mcp_servers`) |
| Invocation | auto-delegate by description + explicit | auto-delegate + `/name` | **explicit only** |
| Context isolation | ✅ own window | ✅ own window | ✅ own session |
| Plugin-bundled | ✅ plugin `agents/` | bundles "Agents" (**verify T5**) | **no** — filesystem `.codex/agents/` only |

> Claude caveat: `permissionMode`, `mcpServers`, and `hooks` are **ignored for plugin subagents** (per Claude's doc) — so they need no adaptation in our context.

**Four gaps (verified):**

1. **Format transform, not field-mapping.** Claude/Cursor MD+YAML → Codex **TOML** with the prompt as a `developer_instructions` string (an `md→toml` + body-into-field transform).
2. **Tool scoping doesn't survive.** Claude's fine-grained `tools`/`disallowedTools` maps only coarsely: `disallowedTools: Write, Edit` → Cursor `readonly: true` / Codex `sandbox_mode = "read-only"`; an arbitrary subset (Read+Grep, no Bash) is **inexpressible** → soft `agent-tools-unscoped`.
3. **Invocation differs.** Codex subagents are **explicit-only** — auto-delegation by description does not exist (see D12).
4. **Codex agents are not plugin-bundled** — they live only in `.codex/agents/`, so a plugin-distributed subagent has a **placement** problem (**verify T4**).

> **D11 (normative) — context isolation is definitional.** A subagent MUST be represented only by a target primitive that provides a **separate context window**. A companion skill MAY *add* activation atop an isolated subagent; it MUST NOT *stand in for* one. If a target has **no** context-isolated subagent primitive, the adapter emits a **hard `agent-not-representable`** finding — it never downgrades the agent to an inline skill. (All three shipped targets satisfy this — verified above; each gives the subagent its own context window/session, model tier, and sandbox.)

> **D12 (normative) — companion skill bridges explicit-only activation.** For a host whose subagents are explicit-only (Codex), the adapter emits the real isolated subagent **plus** a plugin-bundled **companion skill** whose `description` carries the delegation trigger and whose body instructs the main agent to spawn that subagent. The skill recovers description-based activation **without touching** the subagent's context window, model tier, or sandbox; it also carries the `## Initial setup` placement note for `.codex/agents/` (gap 4). Soft `agent-activation-via-companion-skill`. Claude/Cursor auto-delegate natively and need no companion.

**Adaptation summary:** Claude → passthrough; Cursor → field-adapt (`{name, description, model, readonly←disallowedTools, is_background}`); Codex → `md→TOML` + `sandbox_mode` mapping + companion skill. Given the fidelity cost and that few plugins ship agents, this is a **lower-priority, well-flagged** adapter class.

---

## 5. Honesty and diagnostics (preserves P5)

> **D9 (normative).** Every adaptation that drops, relocates, inverts, promotes, or merges content MUST emit a `Finding`. Additive `FindingCode` values (per the `architecture.md` 0.4.0 typed-union contract), aligned with the agentrc warning catalog (`SK*/HK*/PL*`):

| Code | Severity | When |
| --- | --- | --- |
| `invocation-relocated` | soft | invocation policy lifted to a host-native sidecar (e.g. Codex `agents/openai.yaml`) |
| `invocation-widened` | soft | `user-invocable: false` cannot be honored on `<target>` |
| `hook-adapted` | soft | an event/matcher was dropped for a target (e.g. `SessionEnd`/`Notification` on Codex — §4.2.1 D6a) |
| `hook-scope-widened` | soft | a skill-scoped frontmatter hook promoted to plugin-wide on `<target>` |
| `hook-controller-shimmed-cursor` | soft | a Cursor controller hook is served by a generated fail-closed translation shim (§4.2.1 D6b) — verify control semantics |
| `hook-event-unsupported-cursor-cli` | soft | a shimmed event is not delivered by Cursor cloud/CLI agents (`sessionStart`/`sessionEnd`/`beforeSubmitPrompt`/`stop`) — the hook will not fire there |
| `unifier-collision` | hard | two plugins' names collide under the namespacing rule |
| `frontmatter-adapted` | soft | (reserved, §4.4) a key/char rewritten for a runtime-strict host |
| `agent-tools-unscoped` | soft | a subagent's `tools`/`disallowedTools` can't be expressed on `<target>` (only coarse `readonly`/`sandbox_mode`) |
| `agent-activation-via-companion-skill` | soft | a companion skill supplies description-activation for an explicit-only subagent host (§4.5 D12) |
| `agent-not-representable` | hard | `<target>` has no context-isolated subagent primitive (§4.5 D11) — the agent is **not** downgraded to an inline skill |

---

## 6. Grounding rule (process)

> **D10 (normative).** Every per-target contract claim in this spec or its adapter tables MUST cite the **harness's own primary documentation** (or an empirical isolated-host test), not a third-party capability index. The agentrc matrix is a useful starting index but proved stale on Cursor hooks, Cursor plugins, Cursor's skill field set, Codex hooks, and Codex user-invocation. Treat it as a lead, verify at the source, and date the citation.

---

## 7. Edge cases, validation, verify-tasks

- **No-op.** If a target needs nothing emitted, `adapt()` returns nothing and emits no finding.
- **`frontmatter-invalid` precedes everything** — the adapter never runs on unparseable YAML.
- **Idempotence.** `adapt(adapt(x,t),t) == adapt(x,t)` for every target — required for freshness stability (§10.5).
- **Envelope gates emission** — undeclared targets emit nothing.
- **Tests:** golden `(authored, expected-sidecar)` fixtures with a structural assertion per contract-table row; an idempotence test per adapter; a `FindingCode`/severity assertion per rule; the freshness check; and an **isolated-host UAT** (e.g. install into a sandboxed `CODEX_HOME` and assert load/behavior — the method used to verify `frontmatter-invalid`).
- **Verify-tasks (must resolve before the relevant code ships):**
  - **T1** — Cursor's plugin-bundled **hook** declaration file/field and whether it auto-activates (doc-ambiguous).
  - **T2** — Confirm the toolkit's `codex` target emits `agents/openai.yaml`; today it emits `hooks/codex.json` only.
  - **T3** — Codex plugin-hook **trust** UX wording for plugin docs.
  - **T4** — Codex subagent **placement**: `.codex/agents/` is not plugin-bundled — how a plugin-distributed `.toml` lands there (companion-skill `## Initial setup`? symlink?).
  - **T5** — Whether a Cursor **plugin** auto-bundles subagents, or they must land in `.cursor/agents/` (the Cursor plugins doc says plugins bundle "Agents"; the subagents doc is silent — the two are ambiguous together).
  - **T6** — Whether Cursor honors **`failClosed: true` in cloud/CLI agents** (the §4.2.1 D6b shim's fail-safe depends on it; the fail-open default + malformed-JSON-allows bug make this the shim's load-bearing assumption — test on a real Cursor cloud agent).
  - **T7** — **Shell-event ↔ `Bash`-tool stdin synthesis fidelity**: confirm a Claude handler keyed on `tool_name:"Bash"` / `tool_input.command` behaves correctly when fed from Cursor's `beforeShellExecution` `command`/`cwd`/`sandbox` payload (and that `afterShellExecution`'s `output` maps cleanly to `tool_output`).

  > **Resolved this revision (T-payload/return):** the cross-harness **stdin payload and stdout control contract** is now primary-verified for all three live targets (§4.2.1 tables) — Claude↔Codex are contract-identical (modulo `tool_output`→`tool_response`); Cursor diverges on all three axes, which is why D6b mandates a shim rather than a rename. This closes the "is author-once even true for hooks?" question: **yes for Codex, no for Cursor controllers.**

---

## 8. Migration impact

- **No install-model change for claude/cursor/codex** — all stay source-installed (corrected from 0.1.0; no `dist/codex/`).
- **Additive sidecars only** in the source tree (`agents/openai.yaml`, hook JSON) — committed + freshness-checked, like `hooks/codex.json` today.
- **`aggregate` is opt-in**; current single-plugin Gemini/Kiro behavior unchanged when off.
- **Future-envelope candidates** surfaced by the matrix and worth verifying later: **CodeBuddy**, **OpenCode** (CLI + plugins + hooks).

---

## Open questions

- **OQ-1** — Default for single-artifact hosts: N-separate-extensions (simple) vs `aggregate` unify (one install)? Likely per-marketplace config.
- **OQ-2** — Unifier namespacing scheme and unified `name`/`description` derivation (`aipm.workspace.ts`? a designated primary plugin?).
- **OQ-3** — Should skill-frontmatter hooks (D7) be supported now or kept fully reserved until a real skill needs Claude skill-scoping? (ai-plugins has zero today.)
- **OQ-4** — Does the invocation-policy adapter (D4) warrant building now, or reserve until a plugin sets `disable-model-invocation`? (Also zero today.)
