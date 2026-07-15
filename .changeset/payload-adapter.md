---
'@ai-plugin-marketplace/core': minor
---

Emit a generated cross-harness hook payload adapter (`hooks/payload-adapter`) for every plugin
that authors `hooks/claude.yaml`. `hooks/claude.yaml` is authored once in the Claude Code dialect;
Codex is near-identical but not quite (`tool_response` vs `tool_output`, extra additive fields), so
plugin hook handler code previously had to re-derive those deltas by hand. The adapter is a static
`sh` + `jq` filter, emitted regardless of which target(s) the plugin's envelope declares, that
normalizes any supported harness's raw hook stdin payload into one documented canonical shape (the
Claude Code hook envelope, additively extended) — see `docs/specs/payload-adapter.md`.

Behavior: the canonical shape is the Claude Code hook envelope; Codex's `tool_response` gains a
canonical `tool_output` alongside it (never removing the original field); a `harness: {name}`
envelope is added, detected from Codex's additive-only fields (`turn_id`/`model`/`tool_response`/
`agent_transcript_path`), then the `CODEX_HOME` environment variable as a secondary signal, then a
recognized PascalCase `hook_event_name`, else `"unknown"`; `is_subagent` is added for every payload
from a non-empty `agent_id`; `payload-adapter --schema` prints the canonical JSON Schema plus a
single-sourced contract version and exits 0 without reading stdin; a missing `jq` on `PATH`
degrades to a byte-for-byte stdin passthrough, exit 0 (never breaks a hook chain); output key order
is sorted at every nesting level for deterministic, golden-able output.

The adapter is a byte-exact static asset (like the existing Cursor controller-hook shim) — every
plugin that authors hooks receives identical bytes, and `hooks/payload-adapter.generated` carries
its sidecar sentinel so freshness compares it byte-for-byte alongside the existing generated hook
artifacts.
