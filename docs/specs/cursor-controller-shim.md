# Cursor Controller-Hook Shim

Status: Design (approved 2026-07-14)

Implements the controller-hook half of the Cursor hooks target. Companion to
`cursor-hooks-target.md` (the observer-path transform, already shipped) and
`adapter-system.md` §4.2.1 / **D6b** (the governing adapter design). Tracks issue #37.

## 1. Problem

`cursor-hooks-target.md` shipped a transform that renames events, translates the matcher, and
reshapes structure from `hooks/claude.yaml` into `hooks/cursor.json`. It is correct for **observer**
hooks (side-effect only) but **unsafe for controller** hooks — those that return a
block/deny/updated-input decision. A Claude-authored deny gate emitted through the observer
transform **fails open on Cursor**, because the two harnesses' hook **handler contracts** diverge:

| Axis            | Claude (source dialect)                                                                       | Cursor                                                                    |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Event name      | `PreToolUse` (PascalCase)                                                                     | `preToolUse` (camelCase)                                                  |
| Tool identity   | `tool_name:"Bash"`                                                                            | `tool_name:"Shell"`                                                       |
| Control output  | nested `hookSpecificOutput.permissionDecision` (allow/deny/ask) / `decision:"block"`+`reason` | flat `permission` (allow/deny/ask), `agent_message`, `additional_context` |
| Failure default | exit `2` = block (fail-safe)                                                                  | non-zero handler exit = **fail-OPEN** unless `failClosed:true`            |

So a Claude handler dropped in unchanged never sees `tool_name:"Bash"`, and its nested control JSON
is ignored by Cursor — the gate silently no-ops. This spec adds a **generated translation shim**
that makes Claude controller hooks enforce correctly on Cursor.

### 1.1 Empirical grounding (2026-07-14)

Verified against the local CLIs (`cursor-agent` 2026.03.30, `codex exec` 0.144.4) — the in-repo
grounding is the `adapter-system.md` §4.2.1 empirical callout:

- Cursor `preToolUse` stdin carries **both** `conversation_id` and `session_id` (same value) and
  `tool_input:{command,cwd,timeout}` — so `session_id`/`tool_input.command` **pass through**; the
  real remap is `tool_name:"Shell"→"Bash"` and the event casing.
- `{"permission":"deny"}` from `preToolUse` **blocks** the tool (flat control field, verified).
- A **non-zero handler exit fails open**; **`failClosed:true` converts it back to a block** (verified
  in the CLI). Malformed JSON _blocked_ `preToolUse` in the CLI (the "silently allows" report was for
  `beforeShellExecution`), so malformed-output behavior is treated as event-dependent and unsafe to
  rely on — the shim still guarantees valid JSON regardless.

## 2. Decisions

### 2.1 T6 — cloud fail-safe (resolved by assumption)

`adapter-system.md` verify-task **T6** (does Cursor honor `failClosed:true` in **cloud** agents?)
cannot be exercised from the local CLI. **Decision (2026-07-14): assume cloud behaves the same as
local Cursor agents** — `failClosed:true` blocks a crashing handler, `permission:"deny"` blocks, a
bare non-zero exit fails open. The shim is built on this assumption; if a future cloud test refutes
it, the shim's fail-safe (which never relies on the fail-open default — see §4.4) still holds, so the
blast radius is limited to the `failClosed` entry flag.

### 2.2 Classification — by event (decided)

The toolkit cannot introspect an opaque hook `command` to tell an observer from a controller, so
classification is **static, by event**:

| Claude event (source) | Cursor event (emitted) | Class                   | Treatment                        |
| --------------------- | ---------------------- | ----------------------- | -------------------------------- |
| `PreToolUse`          | `preToolUse`           | **controller** (gating) | **shim** + `failClosed:true`     |
| `UserPromptSubmit`    | `beforeSubmitPrompt`   | **controller** (gating) | **shim** + `failClosed:true`     |
| `PostToolUse`         | `postToolUse`          | observer                | event-rename only (cannot block) |
| `Stop`                | `stop`                 | observer                | event-rename only (cannot block) |

Rationale: only "before/gating" events can deny an action; `PostToolUse`/`Stop` fire after the
decision point and cannot block a tool call, so wrapping them buys nothing. The committed
`GATING_EVENTS` set is the single source of this split. Adding a future gating event (e.g.
`PermissionRequest`) is a one-line addition to that set.

> **Consequence — over-wrapping is accepted.** A hook that is _authored_ as an observer but sits on a
> gating event (e.g. a `PreToolUse` logger) still gets the shim + `failClosed:true`. It keeps working;
> the only cost is that if that logger itself crashes, the tool is blocked. This is the safe default
> and needs no author annotation. An opt-out annotation is deferred (§6).

### 2.3 Shim shape — one Node generic runner per plugin (decided)

Emit a **single** committed `hooks/cursor-shim.mjs` per plugin (not N per-hook scripts), parameterized
at invocation. Node — not shell — because the fail-closed guarantee depends on robust
`JSON.parse`/`JSON.stringify` + `try/catch`; a shell/`jq` shim is fragile and `jq` may be absent.
`node` on `PATH` is a safe assumption in these agent-plugin ecosystems.

## 3. Architecture

All additions live under the Cursor target (`packages/core/src/targets/cursor/`) and the build
pipeline; no cross-target imports (architecture §3.4). The transform stays pure; the runner is a
committed static asset.

### 3.1 What the build emits

For a plugin with a `hooks/claude.yaml` and `cursor` in its envelope:

- **Observer events** → unchanged from `cursor-hooks-target.md` (event-rename + matcher translate +
  flatten).
- **Gating events with ≥1 entry** → each flat Cursor entry's `command` is rewritten to invoke the
  shim, and the entry gains `failClosed: true`:

  ```json
  {
    "command": "node \"${CLAUDE_PLUGIN_ROOT:-.}/hooks/cursor-shim.mjs\" preToolUse -- './gate.sh'",
    "matcher": "Shell",
    "failClosed": true
  }
  ```

  - `"${CLAUDE_PLUGIN_ROOT:-.}/hooks/cursor-shim.mjs"` — the shim path uses a **fallback-anchored**
    form, double-quoted so a plugin root containing spaces survives shell expansion (issue #56).
    Cursor's official docs ([cursor.com/docs/hooks](https://cursor.com/docs/hooks)) document no
    plugin-root variable at all. `${CLAUDE_PLUGIN_ROOT}` — and the Cursor-native
    `${CURSOR_PLUGIN_ROOT}` — are confirmed only by Cursor staff forum posts
    ([forum.cursor.com/t/153236](https://forum.cursor.com/t/153236), deanrie, 2026-02-28; and
    [forum.cursor.com/t/157195](https://forum.cursor.com/t/157195), Colin, 2026-04-13), which also
    state plugin-hook cwd = the plugin install path, **except** the `stop` hook (project root,
    intentional). Empirically verified 2026-07-16 against a real `cursor-agent` 2026.07.09 build:
    **project-level** hooks (a project's own `.cursor/hooks.json`, not an installed plugin) get
    **no** plugin-root variable and **no** template substitution — commands run through a real shell
    where POSIX `${VAR:-fallback}` expansion works, and cwd = project root. So an unconditional
    `${CLAUDE_PLUGIN_ROOT}` anchor would expand to an empty string for project-level consumers and,
    because the entry is `failClosed: true`, deny **every** gated tool call. The `:-.` fallback
    resolves to `.` when the variable is unset, which — with cwd = project root — is
    byte-equivalent to the toolkit's previously-proven colocated behavior; when the variable **is**
    set (installed-plugin layout, per the staff-forum statements above), the fallback is unused and
    the invocation anchors to the plugin root as before.
  - `preToolUse` — the Cursor event, so the runner knows which translation table to apply.
  - `-- './gate.sh'` — the original Claude handler command (including any of its own args), embedded
    after a `--` sentinel as a **single POSIX-single-quoted token** (any embedded `'` escaped as
    `'\''`). The single-quoting makes Cursor's shell tokenization preserve the whole handler command
    — spaces, args, and shell metacharacters — as one argument, which the runner then executes
    through a shell (matching Claude's `sh -c`). The `--` sentinel keeps the runner from ever
    confusing the handler command with its own args.

- **`hooks/cursor-shim.mjs`** is emitted once (when any gating-event hook exists) as a committed,
  sentinel-carrying generated file (§3.4).

### 3.2 The shim runner (`hooks/cursor-shim.mjs`)

A deterministic, plugin-independent Node script (byte-identical across plugins — its bytes are a
deterministic constant, not templated per hook). Contract:

1. Parse `argv`: `<cursorEvent> -- <handler command>`. Everything after the `--` sentinel is the
   handler command string (under real Cursor it arrives as a single POSIX-single-quoted token; the
   runner joins any residual elements with a space to reconstitute it).
2. Read all of stdin (Cursor's hook payload JSON).
3. **Translate Cursor → Claude** (§4.1) and run the handler command **through a shell**
   (`spawnSync(handlerCommand, { shell: true, input, encoding: 'utf8', maxBuffer })`), piping the
   Claude payload to its stdin. Shell execution matches Claude's own `sh -c` hook model, so a handler
   using env-var refs / quoting / other shell features execs correctly (the command is the plugin
   author's own trusted hook — shell execution is intended, not an injection vector).
4. Capture the handler's stdout + exit code. **Translate Claude → Cursor** (§4.2) and print the
   Cursor control JSON to stdout, exiting **only after stdout has flushed** (`process.stdout.write(json,
() => process.exit(code))`) so a large allow decision is never truncated into malformed JSON.
5. **Fail-closed on anything unexpected** (§4.4): if the handler exits non-zero, or emits output that
   is not parseable/lacks a recognized decision, print `{"permission":"deny","agent_message":"<why>"}`
   and exit `2`. Always print syntactically valid JSON. Never throw uncaught.

The `maxBuffer` (see §4.4) is set explicitly to 64 MB rather than left at spawnSync's 1 MB default,
which would set `error` + `status === null` on a handler that legitimately emits >1 MB of stdout and
be misread as a spawn failure. The genuine-spawn-failure detection (`error && status === null`)
remains for the case where the shell itself cannot run.

The runner carries an **inverse lookup table** (Cursor→Claude) — the mirror of the transform's
`CLAUDE_TO_CURSOR_*`. It is **generated from the exported `CURSOR_TO_CLAUDE_TOOLS` const** at emit
time (stable, sorted key order — the `.mjs` stays byte-deterministic so freshness round-trips), so
the two tables are one source of truth and cannot drift; a test asserts the emitted literal matches
the const (§5).

### 3.3 Build wiring

Extend `computePluginHookArtifacts` (`packages/core/src/pipeline/build.ts`), the single source of
truth for write + freshness:

- Parse the source YAML **once** for Cursor (the converter's parse). Partition events into observer
  vs gating via `GATING_EVENTS`.
- Observer events → existing path. Gating events → shimmed entries (command rewrite + `failClosed`).
- "Has a gating hook?" is derived from the **already-converted document** (`cursorDocHasGatingHook`:
  a non-empty gating Cursor event key — `preToolUse` / `beforeSubmitPrompt`), not a second re-parse
  of the source. If true, additionally emit `hooks/cursor-shim.mjs` (static content) and its
  **sidecar sentinel** `hooks/cursor-shim.mjs.generated` (see §3.4).
- Freshness compares `hooks/cursor.json`, `hooks/cursor-shim.mjs`, and the `.generated` sidecar
  byte-for-byte.

### 3.4 Sentinel

`hooks/cursor.json` keeps its JSON-field sentinel (`SentinelMode` `'json-field'`).
`hooks/cursor-shim.mjs` uses the **`'sidecar'`** carrier already defined in
`packages/core/src/pipeline/sentinel.ts` — a companion `hooks/cursor-shim.mjs.generated` file holds
the sentinel body (via `sidecarContent(source)` / `sidecarPath(...)`), leaving the `.mjs` itself pure
executable JavaScript. This is exactly the case the sidecar mode exists for (§4.3: "used when the
artifact format can't host a comment") — and it needs **no change to `sentinel.ts`**: the existing
inline carrier is `#`-prefixed (invalid in JS), and the canonical `GENERATOR_ID` is
`@ai-plugin-marketplace/cli` (do not invent a `//`-comment string). The `.mjs` body is a byte-exact
static constant; freshness compares it and its `.generated` sidecar.

## 4. Translation tables (grounded in §1.1)

### 4.1 Cursor → Claude (stdin, per gating event)

**`preToolUse` → `PreToolUse`:**

- `hook_event_name`: `"preToolUse"` → `"PreToolUse"`.
- `tool_name`: inverse-map via `CURSOR_TO_CLAUDE_TOOLS` (`"Shell"→"Bash"`, identity for `Read`/`Write`/
  `Edit`/`Grep`; unknown → passthrough).
- `session_id`: pass through (present); if ever absent, fall back to `conversation_id`.
- `tool_input`: pass through (`{command,…}` already Claude-shaped for shell).
- Other fields (`cwd`, `transcript_path`, `tool_use_id`, `workspace_roots`) pass through.

**`beforeSubmitPrompt` → `UserPromptSubmit`:**

- `hook_event_name`: `"beforeSubmitPrompt"` → `"UserPromptSubmit"`.
- `prompt` / `attachments`: pass through (Claude reads `prompt`).
- `session_id`: as above.

### 4.2 Claude → Cursor (stdout control, per gating event)

**`PreToolUse` handler output → Cursor `preToolUse`:**

| Claude output                                                   | Cursor output                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hookSpecificOutput.permissionDecision: "allow"\|"deny"\|"ask"` | `permission: "allow"\|"deny"\|"ask"`                                                                                                                                                                                                    |
| `decision: "block"` (+ `reason`)                                | `permission: "deny"`, `agent_message: <reason>`                                                                                                                                                                                         |
| `hookSpecificOutput.permissionDecisionReason` / `reason`        | `agent_message`                                                                                                                                                                                                                         |
| `hookSpecificOutput.additionalContext`                          | `additional_context`                                                                                                                                                                                                                    |
| `continue: false` (+ `reason` or `stopReason`)                  | `permission: "deny"`, `agent_message: <reason ?? stopReason>` (a stop-the-turn signal maps to deny at the tool gate; message falls back `reason` → `stopReason` per the hooks contract, since `reason` is scoped to `decision:"block"`) |
| no recognized decision, exit 0                                  | `permission: "allow"` (handler declined to gate)                                                                                                                                                                                        |
| `updatedInput` (rare)                                           | `updated_input`                                                                                                                                                                                                                         |

**`UserPromptSubmit` handler output → Cursor `beforeSubmitPrompt`:**

| Claude output                                  | Cursor output                                             |
| ---------------------------------------------- | --------------------------------------------------------- |
| `decision: "block"` (+ `reason`)               | `continue: false`, `user_message: <reason>`               |
| `continue: false` (+ `reason` or `stopReason`) | `continue: false`, `user_message: <reason ?? stopReason>` |
| `hookSpecificOutput.additionalContext`         | `additional_context`                                      |
| no recognized decision, exit 0                 | `continue: true`                                          |

Fidelity edges are documented, not hidden: Claude's `ask` has a direct Cursor equivalent for
`preToolUse`; `continue:false` is collapsed to a tool-level deny. Cases the tables don't recognize
fall through to §4.4.

### 4.3 Committed inverse tool table

`CURSOR_TO_CLAUDE_TOOLS` = inverse of the transform's `CLAUDE_TO_CURSOR_TOOLS`: `Shell→Bash`,
`Read→Read`, `Write→Write`, `Edit→Edit`, `Grep→Grep`; unknown tool names pass through unchanged.

### 4.4 Fail-closed rules (the safety core)

The runner emits a **deny** and exits `2` — never relying on Cursor's fail-open default — when **any**
of:

- the handler exits non-zero;
- the handler's stdout is not valid JSON;
- the handler's stdout is valid JSON but carries no recognized decision field **and** exited non-zero;
- the runner itself hits an internal error (bad argv, spawn failure, stdin read error).

For `beforeSubmitPrompt` the deny form is `{"continue": false, "user_message": "<why>"}`. In all
cases output is valid JSON and the process exits `2`. The `failClosed:true` entry flag is belt-and-
suspenders: even if the runner somehow died before printing, Cursor blocks.

**Reliability guards (so fail-closed never fires spuriously and an allow never truncates):**

- **Explicit `maxBuffer` (64 MB).** The handler `spawnSync` sets `maxBuffer: 64 * 1024 * 1024`.
  spawnSync's 1 MB default would set `error` + `status === null` on a handler that legitimately emits
  over 1 MB of stdout, which the runner's genuine-spawn-failure detection (`error && status === null`)
  would misread as a spawn failure and deny. The explicit generous buffer avoids that misread while
  keeping the detection for a real "the shell never ran" failure.
- **Flush stdout before exit.** The runner writes its control JSON and exits from the write's flush
  callback (`process.stdout.write(json, () => process.exit(code))`), not immediately after the write.
  A bare `process.exit()` can truncate a pipe-buffered write; on the **allow** path that would yield
  malformed JSON and Cursor would block a legitimately-allowed tool. This applies to the fail-closed
  deny, the allow/`continue:true` path, and the normal interpret→emit path alike.

## 5. Testing

Per the repo's spec-first, multi-layer testing rules. Expected values are hand-derived from this spec.

**Unit — transform (`cursor/transform.test.ts`, extend):**

- A `PreToolUse` source hook produces a shimmed entry: `command` is `node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/cursor-shim.mjs" preToolUse -- <handler>`, `failClosed:true`, matcher translated.
- A `UserPromptSubmit` source hook → `beforeSubmitPrompt` shimmed entry.
- `PostToolUse`/`Stop` → unchanged observer entries (no shim, no `failClosed`) — regression guard on the shipped path.
- A handler command with its own args survives the `--` boundary intact.

**Unit — shim runner (`cursor/cursor-shim.test.ts`, new):** drive `cursor-shim.mjs` as a subprocess with fixture stdin:

- Cursor→Claude: `preToolUse` stdin with `tool_name:"Shell"` reaches the (stub) handler as `PreToolUse`/`Bash`, `tool_input.command` intact.
- Claude→Cursor: stub handler emitting `permissionDecision:"deny"` → runner prints `{"permission":"deny",…}`; `decision:"block"` + reason → `permission:"deny"` + `agent_message`.
- Fail-closed matrix: handler exit 1 → `{"permission":"deny"}` exit 2; malformed handler stdout → deny/exit 2; empty output exit 0 → `permission:"allow"`; bad argv → deny/exit 2.
- `beforeSubmitPrompt` path: block → `{"continue":false,"user_message":…}`.
- Sync guard: `CURSOR_TO_CLAUDE_TOOLS` is the exact inverse of `CLAUDE_TO_CURSOR_TOOLS`.

**Unit — schema (`cursor/schemas.test.ts`, extend):** `cursorHooksFileSchema` accepts `failClosed` on an entry and a `command` invoking the shim.

**Build (`build.test.ts`, extend):** cursor envelope + a gating-event source → emits `hooks/cursor.json` (shimmed entries), `hooks/cursor-shim.mjs`, and the `hooks/cursor-shim.mjs.generated` sidecar; observer-only source → no shim files; freshness round-trips all three byte-for-byte.

**UAT (`cursor/cursor-shim.uat.test.ts`, new, gated on the CLI being present):** the real end-to-end proof. Build a temp workspace with a generated `hooks/cursor.json` + `hooks/cursor-shim.mjs` wrapping a Claude-format deny handler, run the Cursor CLI headless (`cursor-agent -p --trust --force --workspace <dir>` prompting a shell command), and assert the command is **blocked** — use a `touch <marker>` side-effect as ground truth (marker absent = blocked), not stdout scraping. Skip with a logged notice when `cursor-agent` is not on `PATH` (a locally-automatable-but-not-CI test). This closes the loop the unit tests can't: that a real Claude deny gate now enforces on real Cursor.

## 6. Non-goals / future

- **Cursor-only specialized events** (`beforeShellExecution`/`afterShellExecution`) — the shim binds
  gating hooks to `preToolUse`, which is verified to gate shell tools; routing to the specialized
  events (and resolving verify-task T7's remaining `command`/`output` shape) is deferred.
- **Observer opt-out annotation** — a source field to force a gating-event hook onto the event-rename
  path (avoiding over-wrapping, §2.2) is deferred until a real hook needs it.
- **Codex** — no shim (identity-passthrough, D6a; empirically confirmed).
- **Cloud verification of T6** — proceeding on the §2.1 assumption; a real cloud-agent test remains
  worthwhile but is not a blocker given the fail-safe never depends on the fail-open default.
