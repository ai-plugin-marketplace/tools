/**
 * The generated cross-harness hook payload adapter (`hooks/payload-adapter`).
 *
 * `hooks/claude.yaml` is authored once in the Claude Code dialect. Codex is near-identical but not
 * quite (`tool_response` vs `tool_output`, extra additive fields); a plugin's own hook handler code
 * has to re-derive those deltas by hand today. This module holds the byte-exact `sh`+`jq` filter the
 * build emits per plugin (whenever it authors `hooks/claude.yaml`, regardless of which target
 * envelope declares) that normalizes any supported harness's raw hook stdin payload into one
 * documented **canonical payload** — the Claude Code shape, additively extended.
 *
 * The adapter is a **cross-harness concern**, deliberately not implemented under `targets/cursor/`
 * (or any other `targets/**` module) — it is useful to Claude Code and Codex handlers alike and
 * must not depend on, or be depended on by, any single target's transform.
 *
 * {@link PAYLOAD_ADAPTER_SOURCE} is a **static asset**: a deterministic constant, not templated per
 * plugin, so every plugin emits identical bytes and the freshness check round-trips it byte-for-
 * byte. Its embedded `--schema` output is generated from {@link PAYLOAD_ADAPTER_SCHEMA} and
 * {@link PAYLOAD_ADAPTER_CONTRACT_VERSION} at module load — the single-sourced contract version and
 * schema literal, so the TypeScript side and the emitted shell script can never drift (spec §8/D7).
 *
 * @see docs/specs/payload-adapter.md (the governing contract every behavior below implements)
 * @see docs/specs/payload-adapter.md §3-§10 (canonical shape, additive normalization, harness
 *   envelope + detection, is_subagent, --schema/contract version, no-jq posture, determinism)
 * @see docs/specs/payload-adapter.md §11 (emit trigger and sidecar sentinel)
 */

/**
 * The canonical hook-payload contract version (spec §8, D7). A semver string identifying the
 * *canonical-payload contract* documented in `docs/specs/payload-adapter.md` — evolving on its own
 * cadence, deliberately decoupled from `@ai-plugin-marketplace/*` package releases (D7). This is the
 * **single source**: the emitted `--schema` output embeds this exact value, never a hand-duplicated
 * copy.
 */
export const PAYLOAD_ADAPTER_CONTRACT_VERSION = '1.0.0';

/** Filename of the emitted payload adapter, relative to a plugin's `hooks/` directory. */
export const PAYLOAD_ADAPTER_FILENAME = 'payload-adapter';

/**
 * The §13 canonical-payload JSON Schema, as a plain object — the single source both the emitted
 * `--schema` output and any TypeScript consumer share (never hand-duplicated into the shell
 * script). Intentionally permissive (`additionalProperties: true`): per-event-type payloads carry
 * different optional fields, and the adapter's D2 additive-never-destructive rule means every raw
 * field must survive untouched, so the schema constrains only what the adapter itself guarantees to
 * add.
 */
export const PAYLOAD_ADAPTER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ai-plugin-marketplace.dev/schemas/payload-adapter/canonical-payload.json',
  title: 'Canonical hook payload',
  description:
    'Normalized cross-harness hook payload emitted by hooks/payload-adapter. See docs/specs/payload-adapter.md.',
  type: 'object',
  required: ['harness', 'is_subagent'],
  properties: {
    harness: {
      type: 'object',
      description: 'Envelope added by the adapter (D3, §5).',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          enum: ['claude-code', 'codex', 'unknown'],
        },
        version: {
          type: 'string',
          description: 'Reserved; always omitted in the v1 contract (§5).',
        },
      },
      additionalProperties: false,
    },
    is_subagent: {
      type: 'boolean',
      description: 'Derived from presence of a non-empty agent_id (D4, §6).',
    },
    session_id: {
      type: 'string',
      description: 'Present on every Claude/Codex hook payload (§5.2).',
    },
    hook_event_name: {
      type: 'string',
      description:
        'PascalCase event name, e.g. PreToolUse, PostToolUse, Stop, SessionStart, SubagentStart, SubagentStop, UserPromptSubmit, PreCompact (§3, D1).',
    },
    cwd: {
      type: 'string',
    },
    transcript_path: {
      type: 'string',
      description:
        "The invoking harness's own transcript. On Codex sub-agent events this is the sub-agent's own transcript, not the parent's — a documented semantic gap, not normalized (§5.2, §12).",
    },
    tool_name: {
      type: 'string',
      description:
        'Present on tool-use events, Claude vocabulary (Bash, Read, Write, Edit, Grep, ...).',
    },
    tool_input: {
      type: 'object',
      description: 'Present on PreToolUse/PostToolUse.',
    },
    tool_output: {
      description:
        'Present natively on Claude PostToolUse; added additively from tool_response on Codex (D2, §4). tool_response itself is left in place, untouched.',
    },
    agent_id: {
      type: 'string',
      description:
        'Present only on sub-agent-scoped events (SubagentStart/SubagentStop); drives is_subagent (D4).',
    },
    agent_type: {
      type: 'string',
      description:
        'Present only on sub-agent-scoped events. Default vocabulary differs per harness (general-purpose vs default); custom values pass through verbatim, never normalized (§12).',
    },
  },
  additionalProperties: true,
} as const;

/**
 * Escape a string for embedding as a POSIX `sh` single-quoted literal: every `'` becomes
 * `'\''` (end the quote, an escaped literal quote, resume the quote) — the standard POSIX
 * technique, since `sh` single quotes have no escape character of their own.
 */
function escapeForShSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * Render the `--schema` response body as a canonical (sorted-key, no-whitespace-drift) JSON string
 * that the emitted script prints verbatim. Combines the single-sourced contract version and schema
 * object so neither can be hand-edited independently in the shell script (spec §8, D7). The JSON
 * Schema's own prose (§13) contains an apostrophe (`harness's`), so this is escaped for safe
 * splicing into the emitted script's single-quoted `sh` literal rather than assuming the schema
 * text is quote-free.
 */
function renderSchemaResponseLiteral(): string {
  const response = {
    contractVersion: PAYLOAD_ADAPTER_CONTRACT_VERSION,
    schema: PAYLOAD_ADAPTER_SCHEMA,
  };
  return escapeForShSingleQuotes(JSON.stringify(response));
}

/**
 * Byte-exact source of the emitted `hooks/payload-adapter`. A deterministic, plugin-independent
 * POSIX `sh` + `jq` filter (freshness compares it byte-for-byte); it takes no plugin-specific
 * argument, so every plugin that authors `hooks/claude.yaml` receives identical bytes.
 *
 * Contract (docs/specs/payload-adapter.md):
 *  - **D8 (§9), no-`jq` posture**: the very first executable check is for `jq` on `PATH`; if
 *    absent, stdin is passed to stdout byte-for-byte unchanged and the script exits 0 — no
 *    envelope, no `is_subagent`, no `--schema` support (a documented degraded mode, not a failure).
 *  - **D6 (§8), `--schema`**: printed instead of reading stdin, exits 0.
 *  - **D1 (§3), canonical shape**: the Claude Code hook stdin envelope is the hub shape.
 *  - **D2 (§4), additive-never-destructive**: Codex's `tool_response` gains a canonical
 *    `tool_output` alongside it (neither removed); every other field passes through untouched,
 *    including on invalid-JSON input (byte-for-byte passthrough — no envelope can safely be added
 *    to non-JSON, spec §5.1 step 1) and on unknown-harness input (§7).
 *  - **D3 (§5) + §5.1 detection algorithm**: `harness: {name}` is added, detected via Codex's
 *    additive-only fields, then `CODEX_HOME` as a secondary signal, then a recognized PascalCase
 *    `hook_event_name`, else `"unknown"`.
 *  - **D4 (§6), `is_subagent`**: added for every payload (including `unknown`), derived from a
 *    non-empty `agent_id`.
 *  - **D9 (§10), determinism**: the final `jq -S` sorts keys at every nesting level.
 */
export const PAYLOAD_ADAPTER_SOURCE = `#!/bin/sh
# Generated cross-harness hook payload adapter. Do not edit directly.
# Normalizes a Claude Code or Codex hook's raw stdin payload into the canonical shape documented
# at docs/specs/payload-adapter.md. Author hooks/claude.yaml and run "aipm build" -- the sentinel
# lives in payload-adapter.generated.

# D8 (spec section 9): jq is a runtime dependency. Its absence is a documented degraded mode, not
# a failure -- pass stdin through byte-for-byte unchanged and exit 0, before any parsing or argv
# inspection (so --schema degrades identically to the stdin path).
if ! command -v jq >/dev/null 2>&1; then
  cat
  exit 0
fi

# D6/D7 (spec section 8): the --schema response combines the single-sourced contract version and
# the section 13 JSON Schema. Generated from PAYLOAD_ADAPTER_CONTRACT_VERSION / _SCHEMA -- never a
# hand-duplicated literal.
if [ "\${1:-}" = "--schema" ]; then
  printf '%s' '${renderSchemaResponseLiteral()}' | jq -S .
  exit 0
fi

# Buffer stdin to a temp file so an invalid-JSON input can still be echoed back byte-for-byte
# (spec section 5.1 step 1: harness detection is skipped entirely on parse failure -- no envelope
# can safely be added to non-JSON output).
tmp=$(mktemp 2>/dev/null) || { cat; exit 0; }
trap 'rm -f "$tmp"' EXIT INT TERM
cat > "$tmp"

if ! jq -e . "$tmp" >/dev/null 2>&1; then
  cat "$tmp"
  exit 0
fi

# Secondary detection signal (spec section 5.1 step 3): CODEX_HOME set in the adapter's own
# process environment, weaker evidence than an in-payload additive field.
CODEX_HOME_SET=0
if [ -n "\${CODEX_HOME:-}" ]; then
  CODEX_HOME_SET=1
fi

jq -S --argjson codex_home_set "$CODEX_HOME_SET" '
  def known_events:
    ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "PreCompact", "SubagentStart", "SubagentStop"];

  # D3 (section 5) harness detection, section 5.1 steps 2-5.
  def harness_name:
    . as $in
    | if ($in | has("turn_id")) or ($in | has("model")) or ($in | has("tool_response")) or ($in | has("agent_transcript_path")) then
        "codex"
      elif ($codex_home_set == 1) then
        "codex"
      elif ((($in.hook_event_name // null) | type) == "string") and ((known_events | index($in.hook_event_name)) != null) then
        "claude-code"
      else
        "unknown"
      end;

  # D4 (section 6): agent_id present and a non-empty string.
  def is_subagent_val:
    . as $in
    | ($in.agent_id // null) as $a
    | ($a != null and ($a | type) == "string" and ($a | length) > 0);

  # D2 (section 4): additive rename-into tool_output from tool_response -- tool_response itself
  # is left in place, untouched. Never overwrites a native tool_output.
  (if has("tool_response") and (has("tool_output") | not) then .tool_output = .tool_response else . end)
  | . as $normalized
  | $normalized
  # harness and is_subagent are the adapter reserved, authoritative output keys (spec section 4,
  # D2 clarification): always (re)written from the adapter own computation, even if the raw
  # payload already carries a same-named field. D2 never-overwrite/remove/hide guarantee protects
  # harness-emitted payload fields, not this reserved output namespace -- a raw harness or
  # is_subagent field colliding with these names is untrusted input, and passing it through
  # unnormalized would let a caller spoof the values a permission layer keys decisions on.
  | .harness = {name: ($normalized | harness_name)}
  | .is_subagent = ($normalized | is_subagent_val)
' "$tmp"
`;
