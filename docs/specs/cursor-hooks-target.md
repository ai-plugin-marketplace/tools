# Cursor Hooks Target

Status: Design (approved 2026-07-14)

## 1. Problem

The toolkit models hooks with a single canonical source authored in Claude's dialect —
`plugins/<name>/hooks/claude.yaml` (events `PreToolUse`, `PostToolUse`, `Stop`,
`UserPromptSubmit`) — and fans that source out per target in the build pipeline
(`computePluginHookArtifacts`, `packages/core/src/pipeline/build.ts`), gated on each plugin's
envelope:

- `claude` → `hooks/claude.json`
- `gemini` → `hooks/hooks.json` (tool-name matchers translated PascalCase → snake_case)
- `cursor` → **nothing**

For the Cursor target there is no hooks transform. The Cursor plugin manifest's `hooks` field is
left pointing at `hooks/claude.json` — `packages/core/src/targets/cursor/validate.ts` documents
this explicitly: _"the hooks field typically points at `hooks/claude.json`, which is a
Claude-target generated artifact."_ That is a semantic mismatch: Cursor cannot consume a
Claude-format hooks file. A plugin that ships hooks currently hands Cursor a file it cannot read.

Cursor's hook format differs from Claude's in three ways:

1. **Top-level envelope.** Cursor requires `{ "version": 1, "hooks": { … } }`.
2. **Event vocabulary.** camelCase and partly renamed — `preToolUse`, `postToolUse`,
   `beforeSubmitPrompt`, `stop`, plus Cursor-only events (`beforeShellExecution`, `afterFileEdit`,
   …) with no Claude equivalent.
3. **Entry shape.** Cursor's per-event value is a **flat** list of entries
   `{ command, type, matcher?, timeout?, … }`. Claude nests: `{ matcher?, description?, hooks:
[{ type, command }] }`.

Matcher values are Cursor **tool types** (`Shell`, `Read`, `Write`, `Grep`, `MCP:<name>`), so
Claude's `Bash` must become Cursor's `Shell`.

Reference: [Cursor hooks documentation](https://cursor.com/docs/hooks.md).

## 2. Goal & non-goals

**Goal.** When a plugin's envelope includes `cursor` and the plugin ships a `hooks/claude.yaml`
source, the build emits a Cursor-format `hooks/cursor.json` derived mechanically from that source,
wired into the pipeline (write + freshness) and validated, exactly parallel to how the Gemini
target is wired today.

**Non-goals.**

- **Cursor-only events** (`beforeShellExecution`, `afterFileEdit`, `sessionStart`, …). These are
  unreachable from the Claude-dialect source by design; the single-source model is preserved (per
  the approved source model — transform from `claude.yaml`, not a Cursor-native source file).
- **Project-level `.cursor/hooks.json`.** This design covers _plugin-bundled_ hooks referenced via
  the plugin manifest `hooks` field, matching the claude/gemini model. Project/user/enterprise-level
  `.cursor/hooks.json` is out of scope.
- **Auto-rewriting the manifest `hooks` field.** Manifests remain author-authored skeleton files
  (§4.3). This design corrects the _guidance_ (point at `./hooks/cursor.json`) but does not make the
  build mutate an author's manifest.
- **Controller-hook contract translation.** The transform renames events, translates the matcher,
  and reshapes structure — it does **not** translate a hook handler's stdin/stdout contract. That
  is correct for _observer_ hooks (side-effect only: log / notify / format-on-save). It is **not**
  sufficient for _controller_ hooks that return a block/deny/updated-input decision: Cursor's
  handler contract diverges from Claude's on stdin field names, stdout control shape, and failure
  default (Cursor fails **open** and silently allows on malformed JSON), so a Claude-authored deny
  gate can **fail open** on Cursor. Contract-translating controller hooks via a fail-closed shim is
  deferred — tracked in issue #37 (its design lives in the adapter-system spec, §4.2.1 D6b, on
  PR #26 until that spec is merged).

## 3. Architecture

Follows the per-target module shape in `docs/specs/architecture.md` §12.4–§12.5. No file under a
target folder may import from a sibling target folder (§3.4); the pipeline orchestrator
(`build.ts`) is the composition point and already imports both the Claude and Gemini transforms.

### 3.1 New module: `packages/core/src/targets/cursor/transform.ts`

Cursor has no `transform.ts` today. This adds one — pure functions, no I/O — mirroring
`gemini/transform.ts`. It is structured around a small **payload-shape adapter** rather than a
single ad-hoc flatten, so the Claude→Cursor entry-reshaping is a named, testable unit that future
targets or richer Cursor mappings can reuse or extend.

**Committed lookup tables** (per §7.1, mapping tables must be committed in source):

`CLAUDE_TO_CURSOR_EVENTS` (Claude event → Cursor event):

| Claude             | Cursor               |
| ------------------ | -------------------- |
| `PreToolUse`       | `preToolUse`         |
| `PostToolUse`      | `postToolUse`        |
| `Stop`             | `stop`               |
| `UserPromptSubmit` | `beforeSubmitPrompt` |

`CLAUDE_TO_CURSOR_TOOLS` (matcher tool-name → Cursor tool type):

| Claude  | Cursor  |
| ------- | ------- |
| `Bash`  | `Shell` |
| `Read`  | `Read`  |
| `Write` | `Write` |
| `Edit`  | `Edit`  |
| `Grep`  | `Grep`  |

Matchers with no table entry (e.g. `Glob`, `mcp__*` patterns, arbitrary regex) pass through
**unchanged** — identical policy to `translateHooksForGemini`.

**Payload-shape adapter.** A named function converts one Claude matcher block into a list of flat
Cursor entries:

```
adaptMatcherBlockToCursorEntries({ matcher?, description?, hooks: [{type, command}] })
  → [ { command, type, matcher? }, … ]   // one Cursor entry per Claude hooks[] entry
```

- Each entry in the Claude block's `hooks[]` array becomes one Cursor entry.
- The block's `matcher`, if present, is tool-name-translated (`CLAUDE_TO_CURSOR_TOOLS`, passthrough
  otherwise) and attached to every emitted entry; absent matcher → no `matcher` key.
- `description` is dropped (Cursor entries have no description field).

Keeping this as its own function is the "adapt between different hook payload shapes" concern the
design calls out: the event-rename layer and the shape-adapter layer are independently testable, and
adding another shape adaptation later does not touch the event map.

**Top-level assembly.** Iterate the source `hooks` map; for each event **present in**
`CLAUDE_TO_CURSOR_EVENTS`, rename it, map its matcher blocks through the adapter, concatenate, and
add under the renamed key. An event **not** in the map is dropped (not emitted) — it has no faithful
Cursor equivalent, and in a claude-inclusive envelope it would already have been rejected by the
Claude hooks schema. Wrap the result in `{ version: 1, hooks: { … } }`.

**Public API:**

```ts
convertClaudeHooksYamlToCursorJson(yamlContent: string): string
```

Parses the YAML, applies the event + shape transform, and serializes as pretty JSON (2-space
indent, trailing `\n`) — byte-format identical to the Claude/Gemini emitters so the freshness
compare round-trips. Throws on malformed YAML.

### 3.2 Worked example

Source `hooks/claude.yaml`:

```yaml
hooks:
  PreToolUse:
    - matcher: Bash
      description: guard shell
      hooks:
        - { type: command, command: ./guard.sh }
        - { type: command, command: ./log.sh }
  UserPromptSubmit:
    - hooks:
        - { type: command, command: ./prompt.sh }
```

Generated `hooks/cursor.json` (sentinel omitted for clarity):

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "command": "./guard.sh", "type": "command", "matcher": "Shell" },
      { "command": "./log.sh", "type": "command", "matcher": "Shell" }
    ],
    "beforeSubmitPrompt": [{ "command": "./prompt.sh", "type": "command" }]
  }
}
```

Note: two Claude `hooks[]` entries under one matcher block → two flat Cursor entries, each carrying
the translated matcher; `Bash → Shell`; `UserPromptSubmit → beforeSubmitPrompt`; matcher-less block
emits entries with no `matcher` key; `description` dropped.

> **Superseded for gating events (controller shim, issue #37).** This example predates the
> controller-hook shim. `PreToolUse` and `UserPromptSubmit` are **gating** events, so each emitted
> entry's `command` is now rewritten to invoke `hooks/cursor-shim.mjs` with `failClosed: true` (and
> no `type` key) — e.g. `"node ./hooks/cursor-shim.mjs preToolUse -- ./guard.sh"`. The event-rename,
> matcher-translate, and flatten shown above are unchanged; only the gating entries' `command` gains
> the shim wrapper. Observer events (`PostToolUse`, `Stop`) stay byte-identical to the output above.
> See `cursor-controller-shim.md` §3.1/§4.

### 3.3 Pipeline wiring: `packages/core/src/pipeline/build.ts`

Add a third branch to `computePluginHookArtifacts` — the single source of truth shared by
`runBuild` (writes) and the freshness check (compares on-disk bytes) — so both paths are wired at
once:

```
cursor in envelope + hooks YAML present
  → hooks/cursor.json  (Cursor JSON body + json-field `_generated` sentinel, target: 'cursor')
```

The sentinel is applied to the parsed object (top-level `_generated`), serialized 2-space +
trailing newline, matching the existing branches. Output filenames are collision-free:
`claude.json` / `hooks.json` (gemini) / `cursor.json`. `build.ts` imports
`convertClaudeHooksYamlToCursorJson` from `../targets/cursor/transform.js` alongside the existing
Claude/Gemini transform imports.

### 3.4 Validation: `packages/core/src/targets/cursor/schemas.ts` + `validate.ts`

Add `cursorHooksFileSchema` (strict):

- `version: z.literal(1)`
- `hooks: z.partialRecord(cursorHookEventSchema, z.array(cursorHookEntrySchema))`
  - `cursorHookEventSchema`: enum of the four emitted events (`preToolUse`, `postToolUse`, `stop`,
    `beforeSubmitPrompt`). Accepting only the events this transform emits keeps validation aligned
    with what the toolkit produces; Cursor-only events are out of scope (§2).
  - `cursorHookEntrySchema`: `{ command: z.string(), type: z.literal('command').optional(),
matcher: z.string().optional() }` (`.strict()` for now; extend if we later emit
    `timeout`/`loop_limit`/`failClosed`).
- `schemaVersion: z.string().optional()` accepted-not-validated, matching the other schemas.

In `validate.ts`:

- When `hooks/cursor.json` exists in the plugin dir, parse it and validate against
  `cursorHooksFileSchema`; emit a HARD `schema-invalid` finding on failure (mirrors the manifest
  validation path).
- Fix the stale guidance: the manifest `hooks` field should reference `./hooks/cursor.json`, not
  `hooks/claude.json`. Update the code comment and any hint text accordingly.
- Keep the existing `..` parent-traversal guard on the manifest `hooks` string.
- Existence-checking the manifest `hooks` ref stays out of scope — consistent with the current
  conservative stance for build-generated artifacts (they need not exist in a Cursor-only static
  validation context).

## 4. Testing

Per the repo's per-target `*.test.ts` convention and the multi-layer + spec-first testing rules.
Assertions are written by hand from this spec and the Cursor docs (not captured from program
output); the Cursor hooks doc URL is cited at the top of the transform test file.

`cursor/transform.test.ts`:

- Event rename for all four events.
- Tool-name translation, including `Bash → Shell`; identity entries (`Read`, `Write`, `Edit`,
  `Grep`).
- Passthrough of unmapped matchers (`Glob`, an `mcp__*` string, an arbitrary regex).
- Shape adapter: one matcher block with multiple `hooks[]` entries → multiple flat Cursor entries;
  multiple matcher blocks under one event; matcher-less block → entries with no `matcher` key;
  `description` dropped.
- `version: 1` present at top level.
- Negative: malformed YAML throws; a source event outside the four supported is dropped from the
  output (assert it is absent), not crashed on.

`cursor/schemas.test.ts`:

- Valid `cursorHooksFileSchema` document parses.
- Negative: missing/incorrect `version`, unknown event key, entry missing `command`, extra
  unknown entry field (strict rejection).

`build.test.ts` (extend existing):

- `cursor` envelope + hooks YAML present → `hooks/cursor.json` emitted with `_generated` sentinel
  and `target: 'cursor'`.
- Envelope without `cursor` → no `hooks/cursor.json`.
- Freshness: generated bytes round-trip byte-for-byte through `computePluginHookArtifacts`.

`cursor/validate.test.ts` (extend existing):

- A well-formed `hooks/cursor.json` produces no findings.
- A malformed `hooks/cursor.json` produces a HARD `schema-invalid` finding.

## 5. Out-of-scope / future work

- Emitting Cursor-only events would require either a Cursor-native source file or per-matcher
  routing (`PreToolUse[matcher=Bash] → beforeShellExecution`); deferred per the approved source
  model.
- Emitting richer Cursor per-entry options (`timeout`, `loop_limit`, `failClosed`) once the
  canonical source grows fields to carry them.
- Translating Claude `mcp__server__tool` matchers into Cursor `MCP:<name>` form (currently
  passthrough).
