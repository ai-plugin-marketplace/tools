/**
 * Pure mechanical transformations for the Cursor target.
 *
 * Per spec §7.1, the transform layer is a pure function driven by committed lookup tables,
 * bounded to a single target. No I/O is performed here, and no file in this folder imports from
 * a sibling target folder (§3.4) — the Claude source shapes are re-declared locally as minimal
 * interfaces, exactly as `gemini/transform.ts` does.
 *
 * The Claude-dialect hook source (`hooks/claude.yaml`) is fanned out per target by the build
 * pipeline. Cursor's hook format differs from Claude's in three ways (spec §1):
 *
 * 1. **Top-level envelope** — Cursor requires `{ version: 1, hooks: { … } }`.
 * 2. **Event vocabulary** — camelCase and partly renamed (`preToolUse`, `postToolUse`, `stop`,
 *    `beforeSubmitPrompt`).
 * 3. **Entry shape** — Cursor's per-event value is a FLAT list of entries `{ command, type?,
 *    matcher? }`; Claude nests `{ matcher?, description?, hooks: [{ type, command }] }`.
 *
 * The conversion is structured around a named payload-shape adapter
 * ({@link adaptMatcherBlockToCursorEntries}) so the event-rename layer and the entry-reshape
 * layer are independently testable (spec §3.1).
 *
 * **Controller vs observer — by event.** For *observer* hooks (side-effect only: log / notify /
 * format-on-save — they ignore the stdin envelope and emit no control output) the event-rename +
 * matcher-translate + flatten is sufficient. For *controller* hooks that return a
 * block/deny/updated-input decision it is NOT: Cursor's handler contract diverges from Claude's on
 * every axis (stdin field names, stdout control shape, and an opposite fail-OPEN default). Since the
 * toolkit cannot introspect an opaque `command` to classify it, classification is static, by event:
 * the {@link GATING_EVENTS} set (`PreToolUse`, `UserPromptSubmit`) are treated as controllers and
 * their entries are rewritten to invoke the generated fail-closed shim runner
 * ({@link CURSOR_SHIM_FILENAME}) with `failClosed: true`. `PostToolUse`/`Stop` fire after the
 * decision point, cannot block, and stay on the byte-identical observer path (issue #37, spec
 * `cursor-controller-shim.md` §2.2 / §4).
 *
 * @see docs/specs/cursor-hooks-target.md §3 (architecture, committed tables, worked example)
 * @see docs/specs/cursor-controller-shim.md §2.2 (classification), §3.1 (shimmed entry), §4 (tables)
 * @see docs/specs/architecture.md §7 (mechanical transformations), §12.4–§12.5 (module shape)
 * @see https://cursor.com/docs/hooks.md — Cursor hook format
 */

import { parse as parseYaml } from 'yaml';

import { posixSingleQuote } from '../../shell-quoting.js';
import { CURSOR_SHIM_FILENAME } from './shim-runner.js';
import type { CursorHookEvent } from './schemas.js';

// ---------------------------------------------------------------------------
// Committed lookup tables (spec §3.1 / architecture §7.1)
// ---------------------------------------------------------------------------

/**
 * Committed lookup table mapping Claude Code hook event names to Cursor hook event names.
 * A source event NOT present here has no faithful Cursor equivalent and is dropped from the
 * output (spec §2, §3.1). Per architecture §7.1 the table is committed in source.
 */
export const CLAUDE_TO_CURSOR_EVENTS: Readonly<Record<string, CursorHookEvent>> = {
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  Stop: 'stop',
  UserPromptSubmit: 'beforeSubmitPrompt',
};

/**
 * Committed lookup table mapping Claude Code matcher tool names to Cursor tool types. Matchers
 * with no entry here (e.g. `Glob`, `mcp__*` patterns, arbitrary regex) pass through UNCHANGED —
 * identical passthrough policy to `translateHooksForGemini` (spec §3.1). Per architecture §7.1
 * the table is committed in source.
 */
export const CLAUDE_TO_CURSOR_TOOLS: Readonly<Record<string, string>> = {
  Bash: 'Shell',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
};

/**
 * Committed set of Claude source events that are **controllers** (gating): they fire before the
 * decision point and can deny an action, so their hooks are contract-translated through the
 * fail-closed shim (spec `cursor-controller-shim.md` §2.2). Events NOT in this set
 * (`PostToolUse`, `Stop`) are observers — they cannot block, so they keep the byte-identical
 * event-rename path. This is the single source of the split; adding a future gating event (e.g.
 * `PermissionRequest`) is a one-line addition here.
 */
export const GATING_EVENTS: ReadonlySet<string> = new Set<string>([
  'PreToolUse',
  'UserPromptSubmit',
]);

/**
 * The Cursor-side event names of the gating events — the images of {@link GATING_EVENTS} under
 * {@link CLAUDE_TO_CURSOR_EVENTS} (`preToolUse`, `beforeSubmitPrompt`). A converted Cursor document
 * carries a shimmed gating hook iff one of these keys holds a non-empty entry array, which is what
 * {@link cursorDocHasGatingHook} inspects — so "has a gating hook" is derived from the single parse
 * the converter already did, not a second re-parse of the source YAML.
 */
const GATING_CURSOR_EVENTS: ReadonlySet<CursorHookEvent> = new Set<CursorHookEvent>(
  [...GATING_EVENTS]
    .map((claudeEvent) => CLAUDE_TO_CURSOR_EVENTS[claudeEvent])
    .filter((cursorEvent): cursorEvent is CursorHookEvent => cursorEvent !== undefined),
);

// ---------------------------------------------------------------------------
// Local source/target types (no cross-target import — §3.4)
// ---------------------------------------------------------------------------

/**
 * Minimal local type for a single Claude hook entry (a command runner). Declared here rather
 * than imported from `claude/` to honour the cross-target-import prohibition (§3.4).
 */
interface ClaudeHookEntry {
  type?: string;
  command?: string;
}

/**
 * Minimal local type for a single Claude hook matcher block: an optional matcher/description
 * plus the list of hook entries to run.
 */
interface ClaudeHookMatcherBlock {
  matcher?: string;
  description?: string;
  hooks?: ClaudeHookEntry[];
}

/**
 * Minimal local type for the top-level Claude hooks source object (parsed `hooks/claude.yaml`):
 * an optional `hooks` key mapping event names to arrays of matcher blocks.
 */
interface ClaudeHooksSource {
  hooks?: Record<string, ClaudeHookMatcherBlock[]>;
}

/**
 * A single flat Cursor hook entry. Key order is significant for byte-stable serialization.
 * Observer entries: `command`, then `type` (when carried from the source entry), then `matcher`
 * (when the block had one) — matching the worked example in `cursor-hooks-target.md` §3.2. Shimmed
 * (gating) entries: `command` (the shim invocation), then `matcher`, then `failClosed: true` —
 * matching `cursor-controller-shim.md` §3.1 (they carry no `type`; Cursor defaults it to
 * `command`).
 */
interface CursorHookEntry {
  command: string;
  type?: string;
  matcher?: string;
  failClosed?: boolean;
}

/** The top-level Cursor hooks document this transform emits: `{ version: 1, hooks: { … } }`. */
interface CursorHooksDocument {
  version: 1;
  hooks: Partial<Record<CursorHookEvent, CursorHookEntry[]>>;
}

// ---------------------------------------------------------------------------
// Payload-shape adapter (spec §3.1)
// ---------------------------------------------------------------------------

/**
 * Convert one Claude matcher block into a flat list of Cursor entries — the named, independently
 * testable "adapt between different hook payload shapes" concern (spec §3.1).
 *
 * - Each element of the block's `hooks[]` array becomes one Cursor entry, preserving its
 *   `command` and (when present) `type`.
 * - The block's `matcher`, if present, is tool-name-translated via {@link CLAUDE_TO_CURSOR_TOOLS}
 *   (passthrough when absent from the table) and attached to EVERY emitted entry; a matcher-less
 *   block emits entries with NO `matcher` key.
 * - `description` is dropped (Cursor entries have no description field).
 *
 * Pure: no I/O, no mutation of the input.
 *
 * @param block - One Claude matcher block from a `hooks/claude.yaml` event array.
 * @returns One Cursor entry per Claude `hooks[]` element (empty array when the block has none).
 */
export function adaptMatcherBlockToCursorEntries(block: ClaudeHookMatcherBlock): CursorHookEntry[] {
  const translatedMatcher =
    block.matcher !== undefined
      ? (CLAUDE_TO_CURSOR_TOOLS[block.matcher] ?? block.matcher)
      : undefined;

  const entries = block.hooks ?? [];
  return entries.flatMap((entry) => {
    // Drop structurally-odd entries with a missing/empty command rather than inventing an empty
    // string: emitting a Cursor hook with `command: ''` would be a silently-broken hook. Dropping
    // keeps the transform total over malformed input, consistent with the "unsupported event is
    // dropped" rule.
    if (typeof entry.command !== 'string' || entry.command.trim() === '') return [];
    const cursorEntry: CursorHookEntry = { command: entry.command };
    if (entry.type !== undefined) cursorEntry.type = entry.type;
    if (translatedMatcher !== undefined) cursorEntry.matcher = translatedMatcher;
    return [cursorEntry];
  });
}

/**
 * Rewrite one observer-shaped Cursor entry into a **shimmed controller entry** for a gating event
 * (spec `cursor-controller-shim.md` §3.1). The entry's `command` becomes an invocation of the
 * generated shim runner — `node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/<shim>" <cursorEvent> -- '<original
 * command>'` — where the shim path is anchored to `${CLAUDE_PLUGIN_ROOT:-.}` (double-quoted,
 * expanded by the shell Cursor runs hook commands through) with a `:-.` fallback to the current
 * directory. Two consumption layouts are in play: an **installed plugin**, where Cursor sets
 * `CLAUDE_PLUGIN_ROOT` to the plugin's install path (confirmed only by Cursor staff forum posts,
 * not the official docs) so the invocation anchors to the plugin root regardless of cwd; and
 * **project-level/colocated** consumption (e.g. a project's own `.cursor/hooks.json`), where Cursor
 * does not set the variable at all — empirically verified against a real cursor-agent build — so an
 * unconditional `${CLAUDE_PLUGIN_ROOT}` would expand to an empty string and, combined with
 * `failClosed: true`, deny every gated tool call (issue #56). The `.` fallback resolves relative to
 * cwd, which for project-level hooks is the project root — matching the shim's colocated path and
 * preserving the previously-working behavior when the variable is unset. In the invocation, the
 * `--` sentinel separates the runner's own args from the handler command, and the handler command
 * is embedded as a **single POSIX-single-quoted token** so Cursor's shell tokenization preserves it
 * (with any of its own args and shell features) as one argument. The runner then runs that command
 * through a shell, matching Claude's `sh -c` execution. The translated `matcher` is preserved;
 * `failClosed: true` is added; `type` is dropped (Cursor defaults it to `command`). Key order:
 * `command`, `matcher?`, `failClosed`.
 *
 * @param entry - An observer Cursor entry from {@link adaptMatcherBlockToCursorEntries}.
 * @param cursorEvent - The (renamed) Cursor event this hook fires on — passed to the shim so it
 *   selects the correct translation table.
 * @returns The shimmed controller entry.
 */
function toShimmedEntry(entry: CursorHookEntry, cursorEvent: CursorHookEvent): CursorHookEntry {
  const shimmed: CursorHookEntry = {
    command: `node "\${CLAUDE_PLUGIN_ROOT:-.}/hooks/${CURSOR_SHIM_FILENAME}" ${cursorEvent} -- ${posixSingleQuote(entry.command)}`,
  };
  if (entry.matcher !== undefined) shimmed.matcher = entry.matcher;
  shimmed.failClosed = true;
  return shimmed;
}

/**
 * Whether a **converted** Cursor hooks document carries at least one **gating-event** hook with a
 * real entry — i.e. whether the build must additionally emit the shim runner + its sidecar (spec
 * §3.3). Derived from the document {@link convertClaudeHooksYamlToCursorJson} already produced (a
 * non-empty {@link GATING_CURSOR_EVENTS} key), so the build parses the source YAML exactly **once**
 * for Cursor rather than re-parsing it to answer this question. Behavior is identical to inspecting
 * the source directly: the converter emits a non-empty gating key iff a gating source event had ≥1
 * emittable entry.
 *
 * @param doc - The parsed Cursor hooks document (the object form of the converter's JSON output).
 * @returns `true` iff a gating Cursor event key holds ≥1 entry.
 */
export function cursorDocHasGatingHook(doc: unknown): boolean {
  if (typeof doc !== 'object' || doc === null) return false;
  const hooks = (doc as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  const hooksRecord = hooks as Record<string, unknown>;
  for (const cursorEvent of GATING_CURSOR_EVENTS) {
    const entries = hooksRecord[cursorEvent];
    if (Array.isArray(entries) && entries.length > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Top-level assembly + public API
// ---------------------------------------------------------------------------

/**
 * One-shot conversion: parse a `hooks/claude.yaml` string, rename its events and reshape its
 * entries for Cursor, and serialize as pretty-printed JSON.
 *
 * Assembly (spec §3.1): iterate the source `hooks` map; for each event PRESENT in
 * {@link CLAUDE_TO_CURSOR_EVENTS}, rename it, run its matcher blocks through
 * {@link adaptMatcherBlockToCursorEntries}, concatenate the results, and add them under the
 * renamed key. Entries for a {@link GATING_EVENTS} event are additionally rewritten to invoke the
 * fail-closed shim ({@link toShimmedEntry}); observer events keep byte-identical entries. An event
 * NOT in the map is dropped (not emitted). The result is wrapped in `{ version: 1, hooks: { … } }`.
 *
 * Output format: 2-space indent, trailing newline — byte-format identical to the Claude/Gemini
 * emitters so the pipeline freshness compare round-trips (spec §3.3).
 *
 * Pure: no I/O. Throws on malformed YAML.
 *
 * @param yamlContent - Raw YAML string (contents of `hooks/claude.yaml` or `.yml`).
 * @returns Pretty-printed Cursor hooks JSON with a trailing newline.
 * @throws {Error} If the YAML is malformed.
 *
 * @see https://cursor.com/docs/hooks.md — Cursor hook format
 */
export function convertClaudeHooksYamlToCursorJson(yamlContent: string): string {
  const parsed = (parseYaml(yamlContent) ?? {}) as ClaudeHooksSource;
  const sourceHooks = parsed.hooks ?? {};

  const hooks: Partial<Record<CursorHookEvent, CursorHookEntry[]>> = {};
  for (const [claudeEvent, blocks] of Object.entries(sourceHooks)) {
    const cursorEvent = CLAUDE_TO_CURSOR_EVENTS[claudeEvent];
    if (cursorEvent === undefined) continue; // no faithful Cursor equivalent → drop
    if (!Array.isArray(blocks)) continue;

    const entries: CursorHookEntry[] = [];
    for (const block of blocks) {
      entries.push(...adaptMatcherBlockToCursorEntries(block));
    }
    // Gating events are controllers: rewrite each entry to invoke the fail-closed shim (spec
    // §3.1). Observer events (PostToolUse/Stop) keep their byte-identical entries.
    hooks[cursorEvent] = GATING_EVENTS.has(claudeEvent)
      ? entries.map((entry) => toShimmedEntry(entry, cursorEvent))
      : entries;
  }

  const document: CursorHooksDocument = { version: 1, hooks };
  return JSON.stringify(document, null, 2) + '\n';
}
