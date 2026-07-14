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
 * **Scope caveat — observer hooks only.** This transform renames events, translates the matcher,
 * and reshapes structure; it does NOT translate a hook handler's stdin/stdout contract. That is
 * safe for *observer* hooks (side-effect only: log / notify / format-on-save — they ignore the
 * stdin envelope and emit no control output). It is NOT sufficient for *controller* hooks that
 * return a block/deny/updated-input decision: Cursor's handler contract diverges from Claude's on
 * every axis (stdin field names, stdout control shape, and an opposite fail-OPEN default that
 * silently allows on malformed JSON). A Claude-authored deny gate emitted through this transform
 * can therefore fail open on Cursor. Contract-translating controller hooks (a fail-closed shim)
 * is deferred — tracked in issue #37 (its design lives in the adapter-system spec, §4.2.1 D6b,
 * on PR #26 until merged).
 *
 * @see docs/specs/cursor-hooks-target.md §3 (architecture, committed tables, worked example)
 * @see docs/specs/architecture.md §7 (mechanical transformations), §12.4–§12.5 (module shape)
 * @see https://cursor.com/docs/hooks.md — Cursor hook format
 */

import { parse as parseYaml } from 'yaml';

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
 * A single flat Cursor hook entry. Key order is significant for byte-stable serialization:
 * `command`, then `type` (when carried from the source entry), then `matcher` (when the block
 * had one) — matching the worked example in spec §3.2.
 */
interface CursorHookEntry {
  command: string;
  type?: string;
  matcher?: string;
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
 * renamed key. An event NOT in the map is dropped (not emitted). The result is wrapped in
 * `{ version: 1, hooks: { … } }`.
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
    hooks[cursorEvent] = entries;
  }

  const document: CursorHooksDocument = { version: 1, hooks };
  return JSON.stringify(document, null, 2) + '\n';
}
