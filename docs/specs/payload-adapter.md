# Hook Payload Adapter

Status: Draft (proposed 2026-07-15)

Defines the canonical hook-payload contract and the emitted `sh`+`jq` pipe filter that produces
it. Companion to `adapter-system.md` §4.2.1 (the primary-verified cross-harness stdin payload
tables — the canon this spec builds on) and `cursor-controller-shim.md` (the existing
Cursor→Claude input-translation precedent this generalizes). Resolves issue #44's "(proposal)"
contract into a reviewed design. Tracks issue #45.

## 1. Problem

`hooks/claude.yaml` is authored once, in the Claude Code dialect. Codex consumes that dialect
near-identically (`adapter-system.md` §4.2.1 D6a); Cursor's controller path already gets a
generated translation shim (`cursor-controller-shim.md`). But plugin **handler code** — the
script a hook's `command` invokes — has no equivalent help: it re-derives per-harness field
knowledge (event casing, `tool_output` vs `tool_response`, how to tell Codex from Claude) inline,
by hand, in every plugin. "Near-parity" between Claude and Codex is the trap: a handler that reads
`.tool_output` breaks silently the day it receives a Codex `tool_response` payload instead, and
every plugin author re-learns the same deltas independently.

This spec adds a **payload adapter**: a stdin→stdout pipe filter, emitted per-plugin next to the
hook handlers, that normalizes any supported harness's raw hook payload into one documented
**canonical payload**. Handler code then reads one contract regardless of which harness invoked
it.

```sh
payload=$("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter")
session=$(jq -r '.session_id' <<<"$payload")
agent_t=$(jq -r '.agent_type // empty' <<<"$payload")
```

### 1.1 Scope

**v1 targets Claude Code + Codex only** — the two harnesses where handlers run un-shimmed today
and where the near-parity trap lives (§1). Cursor is carried as an explicit **future spoke**
(§12), not specified for build now: its stdin envelope diverges on every axis
(`adapter-system.md` §4.2.1), and normalizing it is a separate, larger design already partially
covered by the controller shim's own translation tables.

See [`docs/guides/hook-handler-authoring.md`](../guides/hook-handler-authoring.md) for the
consumer-facing usage patterns, a reproduced per-field assertability table, and a worked
permission-layer example built on this contract.

## 2. Governing references

- `adapter-system.md` §4.2.1 — the primary-verified cross-harness stdin payload/stdout-control
  tables (Claude source dialect; Codex identity-passthrough; Cursor divergence) and **D6a** (Codex
  identity-passthrough is the canon this spec's "canonical shape = Claude" decision rests on).
- `cursor-controller-shim.md` — the existing generated-shim precedent: static deterministic
  asset, sidecar sentinel, fail-safe-by-construction design. This spec is "the input half,
  factored out and made universal" (issue #44).
- Issue #44 — the feature request, usage patterns, and non-goals this spec ratifies.

## 3. Canonical shape is the Claude Code payload (criterion 1)

> **D1 (normative).** The canonical payload's base shape **is** the Claude Code hook stdin
> envelope, as already canonized by `hooks/claude.yaml` authoring and grounded in
> `adapter-system.md` §4.2.1: event names in **PascalCase** (`PreToolUse`, `PostToolUse`,
> `UserPromptSubmit`, `Stop`, `SessionStart`, `PreCompact`, `SubagentStart`, `SubagentStop`, …),
> tool names in Claude vocabulary (`Bash`, `Read`, `Write`, `Edit`, `Grep`, …), field names as
> Claude emits them (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`,
> `tool_input`, `tool_output`).

This is a direct consequence of D6a (`adapter-system.md`): Codex is identity-passthrough against
the Claude dialect for every field it shares, so choosing Claude as the hub means Codex payloads
need almost no reshaping — only additive normalization (§4). Choosing a synthetic third shape
would require translating both real harnesses instead of one.

## 4. Additive, never destructive (criterion 2)

> **D2 (normative).** The adapter only **adds** fields or **renames-into** a canonical field
> alongside the original. It never removes, overwrites, or hides a field the raw payload carried.
> Harness-specific extras — Codex's `turn_id`, `model`, `agent_transcript_path` — pass through
> **untouched, under their original names**, so a handler already reading raw fields keeps
> working unmodified after the adapter is introduced.

Concretely:

- `tool_response` (Codex's PostToolUse-family output field) is **additively normalized**: the
  adapter adds a canonical `tool_output` key with the same value **alongside** the original
  `tool_response` key. Neither is removed.
- Every other Codex-additive field (`turn_id`, `model`, `permission_mode`,
  `agent_transcript_path`) passes through verbatim; the adapter defines no canonical rename for
  them because Claude has no equivalent field to converge on (documented gaps, not silently
  dropped — consistent with issue #44's non-goal on papering over semantic divergence, §12).
- The adapter never deletes a key present in the input, including unrecognized ones.

> **D2 clarification — reserved output keys.** `harness` (§5) and `is_subagent` (§6) are the
> adapter's own **reserved, authoritative output fields**, not raw payload fields — they are
> always (re)written from the adapter's own computation regardless of what the raw payload
> carried under those names. D2's never-overwrite/remove/hide guarantee protects
> **harness-emitted** payload fields (Codex's `turn_id`, an unrecognized key, etc.); it does not
> extend to this reserved output namespace. A raw payload that happens to carry a `harness` or
> `is_subagent` key is untrusted input colliding with a reserved name — passing such a value
> through unnormalized would let it spoof the very fields a permission-layer consumer keys
> harness/agent-type decisions on, so the adapter overwrites it by design.

## 5. `harness` envelope and detection (criterion 3)

> **D3 (normative).** The adapter adds a top-level `harness` envelope:
>
> ```json
> { "harness": { "name": "claude-code" | "codex" | "unknown", "version": "<string>?" } }
> ```
>
> `harness.version` is **reserved and always omitted in v1** — neither harness's hook stdin
> payload carries a verified version field (`adapter-system.md` §4.2.1's empirical captures show
> none), so there is no grounded source to populate it from yet. A future revision MAY populate it
> once a primary-verified source (payload field or documented env var) exists; until then its
> absence is normal, not a bug, and consumers MUST treat it as optional.

### 5.1 Detection algorithm (normative, deterministic)

Because both Claude and Codex use **PascalCase** event names (`adapter-system.md` §4.2.1), casing
alone cannot discriminate them. Detection instead leans on Codex's **additive-only** fields —
exactly the fields D2 says must never be stripped — plus `CODEX_HOME` as a documented secondary
signal for the rare event where no additive field is present:

1. Parse stdin as JSON. If parsing fails **or the parsed top-level value is not a JSON object**,
   harness detection is skipped entirely — the adapter falls back to the byte-for-byte passthrough
   path (distinct from §7's `unknown`-harness envelope: neither invalid JSON nor a non-object top
   level — an array, number, string, boolean, or `null` — can safely carry an added envelope at
   all, so no `harness`/`is_subagent` fields are added here either).
2. **Codex** if the parsed payload contains **any** of `turn_id`, `model`, `tool_response`,
   `agent_transcript_path` — these are Codex-only additive fields per §4.2.1's empirical capture;
   Claude's payload never emits them.
3. Else, **Codex (secondary signal)** if none of the above fields are present (e.g. a bare `Stop`
   or `SessionStart` event, which carries no Codex-only field) **and** the `CODEX_HOME`
   environment variable is set in the adapter's process environment. This is documented as
   weaker evidence than an in-payload field — an operator running Claude Code with a stray
   `CODEX_HOME` set would misdetect — but it is the only available signal for those events.
4. Else, **`claude-code`** if `hook_event_name` is a non-empty string matching one of the known
   PascalCase Claude/Codex event names. Claude is the hub shape (D1), so this is the default once
   Codex is ruled out. The known-event set is pinned to a single authoritative source:
   `adapter-system.md` §4.2.1's committed Claude↔Codex map (`SessionStart`, `SubagentStart`,
   `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
   `UserPromptSubmit`, `SubagentStop`, `Stop`) **plus** `SessionEnd` and `Notification` — real
   Claude Code events that map explicitly omits (no Codex equivalent, §4.2.1 D6a) but which are
   still valid Claude events for this detection step.
5. Else, **`unknown`** — `hook_event_name` absent, not a string, or not a recognized event name
   (this is also where a future Cursor payload — camelCase `hook_event_name` — lands until a
   Cursor spoke is built; see §12).

### 5.2 Per-field assertability (criterion 3)

Which harnesses can assert each canonical field, so a handler knows what it can rely on:

| Canonical field         | Claude Code                        | Codex                                          | Notes                                                                        |
| ----------------------- | ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `session_id`            | always                             | always                                         | identity field, §4.2.1                                                       |
| `hook_event_name`       | always (PascalCase)                | always (same casing, D6a)                      |                                                                              |
| `cwd`                   | always                             | always                                         |                                                                              |
| `transcript_path`       | always                             | always (own transcript, not the parent's)      | semantic gap on sub-agent events, not a naming gap — not papered over (§12)  |
| `tool_name`             | on tool-use events                 | on tool-use events, identical vocabulary       |                                                                              |
| `tool_input`            | on `PreToolUse`/`PostToolUse`      | on `PreToolUse`/`PostToolUse`                  |                                                                              |
| `tool_output`           | on `PostToolUse` (native)          | **added** by the adapter from `tool_response`  | additive rename-into, §4                                                     |
| `agent_id`              | on sub-agent events only           | on sub-agent events only                       | drives `is_subagent`, §6                                                     |
| `agent_type`            | on sub-agent events only           | on sub-agent events only                       | default vocab differs (`general-purpose` vs `default`) — not normalized, §12 |
| `harness.name`          | **added**, always                  | **added**, always                              | §5                                                                           |
| `harness.version`       | never (reserved)                   | never (reserved)                               | §5                                                                           |
| `is_subagent`           | **added**, always (`true`/`false`) | **added**, always (`true`/`false`)             | §6                                                                           |
| `turn_id` / `model`     | never present                      | present, passthrough only (no canonical field) | Codex-only additive, §4                                                      |
| `agent_transcript_path` | never present                      | present on `SubagentStop`, passthrough only    | Codex-only additive, §4                                                      |

## 6. `is_subagent` derivation (criterion 4)

> **D4 (normative).** The adapter adds a top-level `is_subagent: true | false`, derived as
> `agent_id` being present **and** a non-empty string in the raw payload. This holds for both
> Claude and Codex: both harnesses only emit `agent_id` on sub-agent-scoped events
> (`adapter-system.md` §4.2.1, §4.5). Cursor is out of scope (§1.1) and emits no `agent_id` at
> all — a Cursor payload would always derive `is_subagent: false`, which is documented as a known
> gap, not a bug, should Cursor detection ever land unmodified.

`is_subagent` is added for **every** payload, including `unknown`-harness ones — the derivation
rule (presence of `agent_id`) needs no harness-specific knowledge, so it degrades gracefully
rather than being withheld.

## 7. Unknown harness (criterion 6)

> **D5 (normative).** When detection (§5.1) yields `unknown`, the adapter:
>
> 1. Passes the **entire raw payload through unchanged** — every original key, value, and nesting
>    intact.
> 2. Adds `harness: {"name": "unknown"}` (no `version`).
> 3. Adds `is_subagent` per §6 (derivable without harness-specific knowledge).
> 4. Exits `0`.
>
> The adapter never makes a payload **less** readable than what came in, and never fails a hook
> chain on an unrecognized harness — a gating consumer that wants to fail closed on `unknown`
> makes that choice itself, downstream of the adapter (issue #44).

## 8. `--schema` and the contract version (criterion 5)

> **D6 (normative).** Invoking the emitted filter as `payload-adapter --schema` (instead of piping
> a payload on stdin) prints the canonical payload's **JSON Schema** (§11) plus a **contract
> version** string, and exits `0` without reading stdin.

> **D7 (normative) — the contract version is spec-owned, not the package version.** The contract
> version is a semver string (e.g. `1.0.0`) that identifies **this document's canonical-payload
> contract** — it evolves on its own cadence (a new canonical field, a changed detection rule)
> and is explicitly decoupled from `@ai-plugin-marketplace/*` package releases. It MUST be:
>
> - **Single-sourced**: defined once, as a named constant in the implementing package (not
>   duplicated into the emitted shell script by hand — the build step embeds the one constant's
>   value into the emitted asset, the same way `GENERATOR_ID` in `sentinel.ts` is single-sourced
>   and stamped into every generated artifact).
> - **Test-asserted**: a test asserts the constant equals both (a) the version reported by
>   `--schema` in the emitted asset and (b) the JSON Schema's own version marker (§11), so the
>   three can never drift apart silently.
> - **Never equal to `package.json#version` by construction** — a package patch/minor/major bump
>   MUST NOT change the contract version unless the canonical contract itself changed. (Per this
>   repo's no-hardcoded-versions convention, `package.json#version` is still the correct source
>   for the package's _own_ `--version`/telemetry; this is a distinct, deliberately independent
>   version axis for the _contract_, not an exception to that convention.)

Bumping rule (semver, applied to the contract, not the package): **patch** — documentation-only
clarification, no field/behavior change; **minor** — an additive canonical field or a new
harness's `unknown`→named detection; **major** — a canonical field is renamed/removed, or a
detection rule change would flip an already-shipped payload's `harness.name`. A major bump
requires explicit authorization per this repo's changeset conventions.

## 9. No-`jq` posture (criterion 7)

> **D8 (normative).** The adapter is implemented as a pure `sh` + `jq` filter (§1, substrate
> decision — not re-litigated here), so `jq` is a runtime dependency of every emitted adapter. The
> emitted script's **first executable check**, before any parsing, is for `jq` on `PATH`:
>
> ```sh
> #!/bin/sh
> if ! command -v jq >/dev/null 2>&1; then
>   cat
>   exit 0
> fi
> ```
>
> When `jq` is absent, the adapter passes stdin to stdout **byte-for-byte unchanged** (no
> envelope, no `is_subagent`, no `--schema` support) and exits `0`. This is a **documented degraded
> mode**, not a failure: it is the same "never make the payload less readable, never break the
> hook chain" principle as the unknown-harness path (§7) — reusing that principle rather than
> inventing a second failure taxonomy.

`payload-adapter --schema` under the no-`jq` path prints nothing useful (there is no JSON to
build a schema response with); a consumer that depends on `--schema` succeeding MUST treat a
missing `jq` as an environment precondition, the same way it would treat a missing shell.
Detecting `jq`'s absence for `--schema` specifically reuses the same top-of-script guard — the
guard runs before argv is even inspected, so `--schema` degrades identically to the stdin path
(passthrough of empty/no input, exit `0`), rather than needing a second no-`jq` branch.

## 10. Deterministic output (criterion 8)

> **D9 (normative).** The adapter's JSON output uses **stable, sorted key order** at every nesting
> level — `jq -S` (or the equivalent `--sort-keys` behavior) on the final pipeline stage. This
> makes the canonical form **golden-able**: a handler's test suite can assert against a fixed
> expected-output string instead of a semantically-equal-but-differently-ordered one.

Sorting is applied only to the **added/renamed** canonical structure and to keys the pipeline
touches when reserializing the whole document; it does not reorder values inside opaque
harness-specific blobs beyond what `jq -S`'s recursive object-key sort already does (arrays are
never reordered — only object keys are).

## 11. Emit trigger and sentinel (criterion 9)

> **D10 (normative).** The adapter is emitted **per-plugin**, alongside the existing hook assets
> (`hooks/claude.json`, and — where applicable — `hooks/codex.json`, `hooks/cursor.json`,
> `hooks/cursor-shim.mjs`), whenever a plugin authors a `hooks/claude.yaml`. Emission does not
> depend on whether the plugin's hooks are observers or controllers (unlike the Cursor shim, §2.2
> of `cursor-controller-shim.md`) — the payload adapter is useful to **any** handler, gating or
> not, so its emission trigger is simply "this plugin has hooks at all."

The emitted file is `hooks/payload-adapter`, a plain POSIX shell script starting with
`#!/bin/sh` on **line 1** (required for the shebang to be honored when invoked directly). Because
the sentinel comment block cannot be prepended without displacing the shebang, the adapter uses
the **`'sidecar'`** carrier already defined in `packages/core/src/pipeline/sentinel.ts` — exactly
the precedent `hooks/cursor-shim.mjs` / `hooks/cursor-shim.mjs.generated` set (§3.4 of
`cursor-controller-shim.md`): a companion `hooks/payload-adapter.generated` file holds the
sentinel body (`sidecarContent(source)` / `sidecarPath(...)`), and the script itself stays pure,
executable shell. No change to `sentinel.ts` is required — the sidecar mode is generic over the
artifact it accompanies. Because §1/§11 document invoking the script directly
(`"${CLAUDE_PLUGIN_ROOT}/hooks/payload-adapter"`), the build emits `hooks/payload-adapter` with
the executable bit set (`0o755`); its `.generated` sidecar is never invoked and stays at the
default mode.

The script's bytes are a **deterministic constant** (like `cursor-shim.mjs`): identical across
every plugin that receives one, parameterized by nothing plugin-specific (unlike the Cursor shim,
which embeds a per-hook handler command, the payload adapter takes no plugin-specific argument at
all — it is a pure stdin→stdout filter). Freshness compares `hooks/payload-adapter` and its
`.generated` sidecar byte-for-byte, the same mechanism already covering the Cursor shim pair.

## 12. Non-goals (criterion 10)

Restated and ratified from issue #44:

- **No normalization of hook decision output.** Allow/deny/ask shapes are the Cursor controller
  shim's concern (`cursor-controller-shim.md` §4.2) where Claude/Codex already agree; this spec
  covers only the **input** half.
- **No papering over semantic divergence.** Where harnesses genuinely behave differently — e.g.
  Codex's own-transcript-per-subagent vs. Claude's shared parent transcript, or (out of v1 scope)
  Cursor's fresh-session-per-subagent with no parent back-reference — the adapter documents the
  gap per-field (§5.2) rather than inventing a field rename that would hide it.
- **No normalization of user-defined `agent_type` values.** Only each harness's **default**
  agent-type name gets a documented equivalence note (`general-purpose` on Claude vs. `default` on
  Codex, §5.2); a plugin author's custom `agent_type` string passes through verbatim, untouched.
- **Cursor is a future spoke, not built now.** §1.1 scopes v1 to Claude Code + Codex. A Cursor
  payload today lands on the `unknown` path (§7) — correct, safe, and explicitly not a target for
  this issue. Building Cursor detection/normalization is a separate follow-up that would also want
  to lift the shared tool/event tables the Cursor target already owns (`CLAUDE_TO_CURSOR_TOOLS`,
  `CLAUDE_TO_CURSOR_EVENTS` in `packages/core/src/targets/cursor/transform.ts`) rather than
  duplicating them — out of scope here per this issue's stated non-goal.
- **No lifting of shared tables out of `targets/cursor/`** now, for the same reason.

## 13. Canonical payload JSON Schema

The schema below is the artifact `payload-adapter --schema` prints (§8) and the one an
implementation issue codes against. It is intentionally permissive (`additionalProperties: true`)
— per-event-type payloads carry different optional fields (§5.2), and D2 requires every raw field
to survive untouched, so the schema constrains only what the adapter itself guarantees to add.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-plugin-marketplace.dev/schemas/payload-adapter/canonical-payload.json",
  "title": "Canonical hook payload",
  "description": "Normalized cross-harness hook payload emitted by hooks/payload-adapter. See docs/specs/payload-adapter.md.",
  "type": "object",
  "required": ["harness", "is_subagent"],
  "properties": {
    "harness": {
      "type": "object",
      "description": "Envelope added by the adapter (D3, §5).",
      "required": ["name"],
      "properties": {
        "name": {
          "type": "string",
          "enum": ["claude-code", "codex", "unknown"]
        },
        "version": {
          "type": "string",
          "description": "Reserved; always omitted in the v1 contract (§5)."
        }
      },
      "additionalProperties": false
    },
    "is_subagent": {
      "type": "boolean",
      "description": "Derived from presence of a non-empty agent_id (D4, §6)."
    },
    "session_id": {
      "type": "string",
      "description": "Present on every Claude/Codex hook payload (§5.2)."
    },
    "hook_event_name": {
      "type": "string",
      "description": "PascalCase event name, e.g. PreToolUse, PostToolUse, Stop, SessionStart, SubagentStart, SubagentStop, UserPromptSubmit, PreCompact (§3, D1)."
    },
    "cwd": {
      "type": "string"
    },
    "transcript_path": {
      "type": "string",
      "description": "The invoking harness's own transcript. On Codex sub-agent events this is the sub-agent's own transcript, not the parent's — a documented semantic gap, not normalized (§5.2, §12)."
    },
    "tool_name": {
      "type": "string",
      "description": "Present on tool-use events, Claude vocabulary (Bash, Read, Write, Edit, Grep, ...)."
    },
    "tool_input": {
      "type": "object",
      "description": "Present on PreToolUse/PostToolUse."
    },
    "tool_output": {
      "description": "Present natively on Claude PostToolUse; added additively from tool_response on Codex (D2, §4). tool_response itself is left in place, untouched."
    },
    "agent_id": {
      "type": "string",
      "description": "Present only on sub-agent-scoped events (SubagentStart/SubagentStop); drives is_subagent (D4)."
    },
    "agent_type": {
      "type": "string",
      "description": "Present only on sub-agent-scoped events. Default vocabulary differs per harness (general-purpose vs default); custom values pass through verbatim, never normalized (§12)."
    }
  },
  "additionalProperties": true
}
```

## 14. Testing

Per this repo's spec-first, multi-layer testing rules — expected values are hand-derived from
this spec, not gold-mastered from a running implementation.

- **Unit — detection (`payload-adapter/detect.test.ts`):** one case per §5.1 branch — a Codex
  payload carrying `turn_id`, one carrying only `tool_response`, a Codex `Stop` payload with no
  additive field but `CODEX_HOME` set, a Claude payload with none of the additive fields, an
  invalid-JSON input, and a payload with a non-PascalCase `hook_event_name` (the Cursor-shaped
  case) — each asserted against the exact `harness.name` §5.1 specifies.
- **Unit — additive normalization (`payload-adapter/normalize.test.ts`):** a Codex `tool_response`
  payload gains `tool_output` with the same value while `tool_response` remains present and
  byte-identical; a Claude payload with native `tool_output` is unchanged; every unrecognized
  input key survives verbatim (regression guard for D2).
- **Unit — `is_subagent` (`payload-adapter/subagent.test.ts`):** payloads with a non-empty
  `agent_id` → `true`; missing/empty `agent_id` → `false`; an `unknown`-harness payload with
  `agent_id` still derives correctly (§6's "degrades gracefully" claim).
- **Unit — unknown-harness passthrough (`payload-adapter/unknown.test.ts`):** a payload with no
  recognizable `hook_event_name` is returned with every original byte-for-byte key intact, plus
  exactly `harness.name:"unknown"` and `is_subagent` added; exit code `0`.
- **Unit — no-`jq` posture (`payload-adapter/no-jq.test.ts`):** invoke the emitted script with
  `PATH` scrubbed of `jq` — stdin reappears on stdout byte-for-byte, exit `0`, both for a payload
  input and for `--schema`.
- **Unit — determinism (`payload-adapter/determinism.test.ts`):** the same logical payload with
  keys supplied in two different orders produces byte-identical output (regression guard for D9).
- **Unit — `--schema`/contract version (`payload-adapter/schema.test.ts`):** `--schema` output
  parses as valid JSON Schema; the reported contract version string equals the single-sourced
  constant (D7) and matches the version this spec's schema (§13) is written against; a schema
  fixture is asserted structurally against §13 field-by-field (never a snapshot, per this repo's
  spec-first assertion rule).
- **Build (`build.test.ts`, extend):** a plugin with `hooks/claude.yaml` (any event, observer or
  controller) → build emits `hooks/payload-adapter` and `hooks/payload-adapter.generated`
  byte-for-byte per plugin; freshness round-trips both; a plugin with no `hooks/claude.yaml` emits
  neither (regression guard for D10's emission trigger).
- **UAT (`payload-adapter.uat.test.ts`, gated on `jq`/`sh` being present):** pipe a real captured
  Claude Code and a real captured Codex `PreToolUse` payload (fixtures grounded in
  `adapter-system.md` §4.2.1's empirical captures) through the emitted script as a subprocess;
  assert the canonical fields a downstream handler would read (`session_id`, `harness.name`,
  `is_subagent`, `tool_output`) resolve correctly for both, closing the loop the unit tests can't:
  that a real harness's real payload, piped through the real emitted asset, produces the contract
  this spec defines.

## Open questions

- **OQ-1** — Should `harness.version` gain a real source once one is verified (e.g. a Codex
  `CODEX_VERSION`-style env var, or a future payload field), or should the field be dropped from
  the schema entirely until then? Currently reserved-but-unpopulated (§5); revisit once a primary
  source is found.
- **OQ-2** — Should the adapter offer an opt-in strict mode that exits non-zero on `unknown`
  harness, for gating consumers that want fail-closed-on-unrecognized instead of the default
  fail-open passthrough? Deferred until a concrete consumer asks (issue #44 leaves this to
  gating consumers downstream of the adapter, §7).
