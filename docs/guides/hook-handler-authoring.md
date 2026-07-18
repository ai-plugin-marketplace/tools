# Authoring hook handlers with the payload adapter

`hooks/claude.yaml` is authored once, in the Claude Code dialect. Codex consumes that dialect
near-identically, but not quite (`tool_response` vs. `tool_output`, extra additive fields like
`turn_id`) — so a hook handler that reads raw payload fields has to re-derive those per-harness
deltas by hand, and re-learns them again every time a harness's payload shape shifts.

The toolkit's build step emits **`hooks/payload-adapter`** next to your handlers, for any plugin
that authors `hooks/claude.yaml`: a static `sh` + `jq` pipe filter that reads a harness's raw hook
payload on stdin and writes one documented **canonical payload** on stdout. Your handler code then
reads a single contract, regardless of which harness invoked it.

This guide walks through the three ways a handler uses the adapter. The full normative contract —
detection rules, the JSON Schema, the per-field assertability table this page's [table
below](#per-field-assertability) is drawn from — lives in
[`docs/specs/payload-adapter.md`](../specs/payload-adapter.md).

## Pattern 1 — normalize-then-read (the default)

Pipe the handler's stdin through the adapter first, then read canonical fields with `jq`. This is
the right default for almost every handler: the logic below is identical whether Claude Code or
Codex invoked it, with no `if`-forking on harness at all.

```sh
#!/usr/bin/env bash
set -euo pipefail

payload=$("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter")

event=$(jq -r '.hook_event_name' <<<"$payload")
[ "$event" = "PreToolUse" ] || exit 0

tool=$(jq -r '.tool_name' <<<"$payload")
session=$(jq -r '.session_id' <<<"$payload")
```

## Pattern 2 — harness-aware but normalized

Some handlers genuinely need to branch on which harness is running — for example, an event that
only exists on one harness (Codex's `SubagentStart`/`SubagentStop`, or a future harness-specific
capability). Branch on the adapter's own `harness.name` discriminator instead of sniffing payload
shape yourself:

```sh
payload=$("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter")
harness=$(jq -r '.harness.name' <<<"$payload")   # "claude-code" | "codex" | "unknown"

case "$harness" in
  codex)
    turn_id=$(jq -r '.turn_id // empty' <<<"$payload")
    ;;
  claude-code)
    : # Claude-only behavior, if any
    ;;
  unknown)
    # An unrecognized harness (or a future one the adapter hasn't learned yet). The adapter
    # never fails the hook chain on this — decide your own fail-open/fail-closed posture here.
    exit 0
    ;;
esac
```

## Pattern 3 — `--schema` introspection

Run the emitted adapter with `--schema` instead of piping a payload, to print the canonical
payload's JSON Schema plus the contract version it implements — no stdin required:

```sh
"${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter" --schema
```

```json
{
  "contractVersion": "1.0.0",
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://ai-plugin-marketplace.dev/schemas/payload-adapter/canonical-payload.json",
    "title": "Canonical hook payload"
  }
}
```

(Trimmed for brevity — the full schema, with every canonical property documented, is in
[`docs/specs/payload-adapter.md` §13](../specs/payload-adapter.md#13-canonical-payload-json-schema).)

Use this in plugin CI to pin or assert the contract version your handlers were written against,
so a future major bump (a canonical field renamed or removed) fails your build instead of silently
producing a payload shape your handler no longer understands:

```sh
version=$("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter" --schema | jq -r '.contractVersion')
[ "$version" = "1.0.0" ] || { echo "payload-adapter contract version drifted: $version" >&2; exit 1; }
```

## Per-field assertability

Not every canonical field is present on every event, and not every harness populates every field
the same way. This table (reproduced from
[`docs/specs/payload-adapter.md` §5.2](../specs/payload-adapter.md#52-per-field-assertability))
tells a handler what it can rely on before reading a field:

| Canonical field         | Claude Code                        | Codex                                          | Notes                                                                   |
| ----------------------- | ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `session_id`            | always                             | always                                         | identity field                                                          |
| `hook_event_name`       | always (PascalCase)                | always (same casing)                           |                                                                         |
| `cwd`                   | always                             | always                                         |                                                                         |
| `transcript_path`       | always                             | always (own transcript, not the parent's)      | semantic gap on sub-agent events, not a naming gap — not papered over   |
| `tool_name`             | on tool-use events                 | on tool-use events, identical vocabulary       |                                                                         |
| `tool_input`            | on `PreToolUse`/`PostToolUse`      | on `PreToolUse`/`PostToolUse`                  |                                                                         |
| `tool_output`           | on `PostToolUse` (native)          | **added** by the adapter from `tool_response`  | additive rename-into; `tool_response` itself stays present, untouched   |
| `agent_id`              | on sub-agent events only           | on sub-agent events only                       | drives `is_subagent`                                                    |
| `agent_type`            | on sub-agent events only           | on sub-agent events only                       | default vocab differs (`general-purpose` vs `default`) — not normalized |
| `harness.name`          | **added**, always                  | **added**, always                              | `"claude-code"` \| `"codex"` \| `"unknown"`                             |
| `harness.version`       | never (reserved)                   | never (reserved)                               | no verified source yet in either harness                                |
| `is_subagent`           | **added**, always (`true`/`false`) | **added**, always (`true`/`false`)             | derived from presence of a non-empty `agent_id`                         |
| `turn_id` / `model`     | never present                      | present, passthrough only (no canonical field) | Codex-only additive field                                               |
| `agent_transcript_path` | never present                      | present on `SubagentStop`, passthrough only    | Codex-only additive field                                               |

A field marked "always" is safe to read unconditionally; a field marked "on \<event\>" should be
read with `// empty` (or an equivalent guard) and checked for emptiness before use, since it will
be absent on other events.

## Worked example — a permission/grant layer keyed on session and sub-agent

A common toolsmith-style consumer is a **permission/grant hook**: a `PreToolUse` handler that
decides allow/ask based on which session and which sub-agent is asking. The adapter's real value
here is _structural_, not semantic: `is_subagent` is derived identically on both harnesses from
`agent_id` (§6), and `session_id` / `tool_name` are read the same way regardless of which harness
invoked the handler, so a handler that keys a grant on these fields doesn't have to special-case
Codex's raw payload shape at all.

`agent_type`, by contrast, is **not** normalized — only each harness's default vocabulary is
documented, not translated (`general-purpose` on Claude Code vs. `default` on Codex; a plugin
author's custom `agent_type` string passes through verbatim, §12). A handler that wants to key a
grant on `agent_type` still owns that difference itself, e.g. by branching on `harness.name` or by
treating the raw value as opaque per-harness input rather than assuming it's comparable across
harnesses.

```sh
#!/usr/bin/env bash
set -euo pipefail

# Stub — replace with your plugin's real grant lookup (e.g. reading a grant store file).
grant_allows() {
  local grant_key="$1" tool_name="$2"
  [ -f "$CLAUDE_PLUGIN_ROOT/grants/${grant_key}:${tool_name}.granted" ]
}

payload=$("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/payload-adapter")

event=$(jq -r '.hook_event_name' <<<"$payload")
[ "$event" = "PreToolUse" ] || exit 0

session_id=$(jq -r '.session_id' <<<"$payload")
is_subagent=$(jq -r '.is_subagent' <<<"$payload")
tool_name=$(jq -r '.tool_name' <<<"$payload")

# Grants keyed on session_id x tool_name: both are read the same way on either harness (§5.2), so
# a grant recorded on one harness is honored (or correctly re-asked) on the other.
grant_key="${session_id}:${tool_name}"

if [ "$is_subagent" = "true" ] && [ "$tool_name" = "Bash" ]; then
  if grant_allows "$grant_key" "$tool_name"; then
    echo '{"decision": "allow"}'
  else
    echo '{"decision": "ask"}'
  fi
  exit 0
fi

echo '{"decision": "allow"}'
```

Because `session_id`, `is_subagent`, and `tool_name` are read from the adapter's canonical payload
rather than harness-specific field names, `grant_key` is stable across Claude Code and Codex: the
same sub-agent asks for the same tool under the same key on either harness, so a grant recorded on
one harness is honored (or correctly re-asked) on the other. The same structural stability applies
to any handler that reads `tool_output` on `PostToolUse` — the adapter adds it additively from
Codex's `tool_response` (§4, §5.2), so a post-tool handler reads one field name unconditionally on
either harness instead of re-deriving the rename itself. What the adapter deliberately does
**not** do is make `agent_type` _values_ comparable across harnesses (§12) — a handler that wants
to branch on sub-agent _type_ (not just sub-agent _presence_, which `is_subagent` already covers)
must account for the differing default vocab itself, for example by branching on `harness.name`.

## Colocated mode and the `CLAUDE_PLUGIN_ROOT` fallback

Every example above anchors the adapter invocation itself with a shell fallback —
`${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}` — rather than a bare `${CLAUDE_PLUGIN_ROOT}`. That same
habit matters for **the rest of your handler command too**, not just the adapter call, if your
plugin is meant to work as project-level/colocated hooks (a project's own `hooks/claude.yaml`,
not an installed marketplace plugin) in addition to a normal installed-plugin layout.

The gap this closes: the [cursor-controller-shim spec](../specs/cursor-controller-shim.md#311-colocated-mode-and-the-authors-own-handler-command)
documents that the shim's own emitted path is anchored with `${CLAUDE_PLUGIN_ROOT:-.}` so it still
resolves when Cursor sets no plugin-root variable at all (colocated mode). But the **handler
command** after the shim's `--` sentinel is your own string from `hooks/claude.yaml`, and the
emitter passes it through verbatim — it is never rewritten. If you write that command as
`${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh` with no fallback (the natural thing to write, and correct
for a marketplace-installed plugin, where Cursor is expected to set the variable (confirmed by
Cursor staff forum posts, cursor-controller-shim spec §3.1), it resolves to an empty prefix in
colocated mode. The shim itself starts fine — only your handler fails to resolve — but because
gating-hook entries carry `failClosed: true`, every gated call is denied. It's the same symptom
as an unanchored shim path, one level deeper, in a command the toolkit doesn't generate and can't
fix on your behalf.

**Convention:** if your plugin intends to support colocated/project-level hooks, author gating-hook
handler commands with the same fallback form:

```sh
${CLAUDE_PLUGIN_ROOT:-.}/scripts/gate.sh
```

rather than:

```sh
${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh
```

**Per-harness caveats — verify before relying on this for a harness not listed here:**

- **Claude Code**: performs a textual substitution of the exact `${CLAUDE_PLUGIN_ROOT}` token in
  hook commands, but also exports `CLAUDE_PLUGIN_ROOT` into the handler's environment. Because the
  variable is exported (not just substituted), the shell-fallback form
  `${CLAUDE_PLUGIN_ROOT:-.}` should still resolve correctly when the shell itself expands it —
  the textual substitution and the exported variable agree.
- **Cursor**: mixed evidence (cursor-controller-shim spec §3.1). Installed-plugin layout is only
  staff-forum-confirmed to set the variable (Cursor's official docs document no plugin-root
  variable at all). Colocated/project-level layout is empirically verified — 2026-07-16, against a
  real `cursor-agent` build — to set **no** plugin-root variable, with commands running through a
  real shell where POSIX `${VAR:-fallback}` expansion works. This colocated case is the one the
  convention exists for.
- **Codex**: not yet confirmed. Treat Codex handler-command behavior under this fallback form as
  **verify per harness** rather than assuming parity with Claude Code — do not rely on it there
  until it's been checked against a real Codex invocation.

A future validate-time lint that flags a bare `${CLAUDE_PLUGIN_ROOT}` in a gating-hook handler
command, when a plugin has opted into colocated support, is a plausible follow-up to catch this
class of mistake at build time instead of at hook-invocation time. It is not implemented today —
this section is the interim guidance.
