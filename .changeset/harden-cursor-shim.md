---
'@ai-plugin-marketplace/core': patch
---

Harden the generated Cursor controller-hook shim (`hooks/cursor-shim.mjs`).

- **Shell fidelity.** The transform now embeds the original Claude handler command as a single
  POSIX-single-quoted token after the `--` sentinel, and the runner executes everything after `--`
  through a shell (`spawnSync(cmd, { shell: true, … })`) — matching Claude's own `sh -c` hook
  model. A handler command using env-var refs, quoting, or its own args now execs correctly on
  Cursor instead of failing to run (and denying).
- **No stdout truncation.** The runner flushes stdout before exiting
  (`process.stdout.write(json, () => process.exit(code))`) on the fail-closed, allow/continue, and
  interpret paths, so a large allow decision is never truncated into malformed JSON.
- **Explicit spawn `maxBuffer` (64 MB).** A handler emitting more than the default 1 MB of stdout is
  no longer misread as a spawn failure and denied.
- **Single YAML parse for Cursor.** "Has a gating hook?" is derived from the already-converted
  Cursor document rather than a second parse of the source.
- **Single source of truth for the tool table.** The runner's `CURSOR_TO_CLAUDE_TOOLS` is generated
  from the exported const at emit time (stable, sorted key order — the `.mjs` stays
  byte-deterministic), so the two copies cannot drift.

Fail-closed safety is unchanged: a non-zero handler exit, malformed handler output, bad argv, spawn
failure, or internal error still emits a deny and exits 2, always as valid JSON.
