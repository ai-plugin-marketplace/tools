/**
 * Tests for Cursor target mechanical transformations.
 *
 * Covers the committed lookup tables (`CLAUDE_TO_CURSOR_EVENTS`, `CLAUDE_TO_CURSOR_TOOLS`), the
 * payload-shape adapter (`adaptMatcherBlockToCursorEntries`), and the one-shot converter
 * (`convertClaudeHooksYamlToCursorJson`). All functions under test are pure (no I/O).
 *
 * Expected values are hand-written from the spec and the Cursor hooks documentation — not
 * captured from program output.
 *
 * @see docs/specs/cursor-hooks-target.md §3 (architecture, tables, worked example), §4 (tests)
 * @see https://cursor.com/docs/hooks.md — Cursor hook format
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_TO_CURSOR_EVENTS,
  CLAUDE_TO_CURSOR_TOOLS,
  GATING_EVENTS,
  adaptMatcherBlockToCursorEntries,
  convertClaudeHooksYamlToCursorJson,
  cursorDocHasGatingHook,
} from './transform.js';

// ---------------------------------------------------------------------------
// CLAUDE_TO_CURSOR_EVENTS — committed event map (spec §3.1)
// ---------------------------------------------------------------------------

describe('CLAUDE_TO_CURSOR_EVENTS', () => {
  it('maps PreToolUse → preToolUse', () => {
    expect(CLAUDE_TO_CURSOR_EVENTS.PreToolUse).toBe('preToolUse');
  });

  it('maps PostToolUse → postToolUse', () => {
    expect(CLAUDE_TO_CURSOR_EVENTS.PostToolUse).toBe('postToolUse');
  });

  it('maps Stop → stop', () => {
    expect(CLAUDE_TO_CURSOR_EVENTS.Stop).toBe('stop');
  });

  it('maps UserPromptSubmit → beforeSubmitPrompt', () => {
    expect(CLAUDE_TO_CURSOR_EVENTS.UserPromptSubmit).toBe('beforeSubmitPrompt');
  });

  it('contains exactly the four canonical event mappings (no additions, no omissions)', () => {
    expect(Object.keys(CLAUDE_TO_CURSOR_EVENTS).sort()).toStrictEqual([
      'PostToolUse',
      'PreToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
  });
});

// ---------------------------------------------------------------------------
// CLAUDE_TO_CURSOR_TOOLS — committed tool-name map (spec §3.1)
// ---------------------------------------------------------------------------

describe('CLAUDE_TO_CURSOR_TOOLS', () => {
  it('maps Bash → Shell (the one true rename)', () => {
    expect(CLAUDE_TO_CURSOR_TOOLS.Bash).toBe('Shell');
  });

  it('maps Read/Write/Edit/Grep to themselves (identity)', () => {
    expect(CLAUDE_TO_CURSOR_TOOLS.Read).toBe('Read');
    expect(CLAUDE_TO_CURSOR_TOOLS.Write).toBe('Write');
    expect(CLAUDE_TO_CURSOR_TOOLS.Edit).toBe('Edit');
    expect(CLAUDE_TO_CURSOR_TOOLS.Grep).toBe('Grep');
  });

  it('contains exactly the five canonical tool mappings', () => {
    expect(Object.keys(CLAUDE_TO_CURSOR_TOOLS).sort()).toStrictEqual([
      'Bash',
      'Edit',
      'Grep',
      'Read',
      'Write',
    ]);
  });
});

// ---------------------------------------------------------------------------
// adaptMatcherBlockToCursorEntries — payload-shape adapter (spec §3.1 / §4)
// ---------------------------------------------------------------------------

describe('adaptMatcherBlockToCursorEntries', () => {
  it('emits one flat Cursor entry per Claude hooks[] element, carrying the translated matcher', () => {
    const entries = adaptMatcherBlockToCursorEntries({
      matcher: 'Bash',
      description: 'guard shell',
      hooks: [
        { type: 'command', command: './guard.sh' },
        { type: 'command', command: './log.sh' },
      ],
    });
    expect(entries).toStrictEqual([
      { command: './guard.sh', type: 'command', matcher: 'Shell' },
      { command: './log.sh', type: 'command', matcher: 'Shell' },
    ]);
  });

  it('drops the description field (Cursor entries have none)', () => {
    const [entry] = adaptMatcherBlockToCursorEntries({
      matcher: 'Read',
      description: 'should not appear',
      hooks: [{ type: 'command', command: './r.sh' }],
    });
    expect(entry).not.toHaveProperty('description');
  });

  it('emits entries with NO matcher key when the block has no matcher', () => {
    const entries = adaptMatcherBlockToCursorEntries({
      hooks: [{ type: 'command', command: './prompt.sh' }],
    });
    expect(entries).toStrictEqual([{ command: './prompt.sh', type: 'command' }]);
    expect(entries[0]).not.toHaveProperty('matcher');
  });

  it('translates Bash → Shell and passes an unmapped matcher through unchanged', () => {
    const bashEntry = adaptMatcherBlockToCursorEntries({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: './a.sh' }],
    })[0];
    expect(bashEntry?.matcher).toBe('Shell');

    const globEntry = adaptMatcherBlockToCursorEntries({
      matcher: 'Glob',
      hooks: [{ type: 'command', command: './b.sh' }],
    })[0];
    expect(globEntry?.matcher).toBe('Glob');
  });

  it('returns an empty array for a block with no hooks[]', () => {
    expect(adaptMatcherBlockToCursorEntries({ matcher: 'Read' })).toStrictEqual([]);
  });

  it('drops entries whose command is missing or empty, keeping valid siblings in the same block', () => {
    // Malformed source YAML can yield a hooks[] element with no `command` (or an empty/whitespace
    // one). Emitting `{ command: '' }` would be a silently-broken Cursor hook, so such entries are
    // dropped — while a valid sibling in the same block is still emitted (spec §3.1: keep the
    // transform total over structurally-odd input).
    const entries = adaptMatcherBlockToCursorEntries({
      matcher: 'Bash',
      hooks: [
        { type: 'command' }, // missing command → dropped
        { type: 'command', command: '   ' }, // whitespace-only command → dropped
        { type: 'command', command: '' }, // empty command → dropped
        { type: 'command', command: './valid.sh' }, // valid sibling → kept
      ],
    });
    expect(entries).toStrictEqual([{ command: './valid.sh', type: 'command', matcher: 'Shell' }]);
  });
});

// ---------------------------------------------------------------------------
// convertClaudeHooksYamlToCursorJson — event rename + envelope
// ---------------------------------------------------------------------------

/** Parse the converter output into a typed object for structural assertions. */
interface CursorDoc {
  version: number;
  hooks: Record<string, { command: string; type?: string; matcher?: string }[]>;
}
function convertToDoc(yaml: string): CursorDoc {
  return JSON.parse(convertClaudeHooksYamlToCursorJson(yaml)) as CursorDoc;
}

describe('convertClaudeHooksYamlToCursorJson — event rename (all four)', () => {
  it('renames PreToolUse → preToolUse', () => {
    const doc = convertToDoc(
      'hooks:\n  PreToolUse:\n    - hooks:\n        - { command: ./x.sh }\n',
    );
    expect(Object.keys(doc.hooks)).toStrictEqual(['preToolUse']);
  });

  it('renames PostToolUse → postToolUse', () => {
    const doc = convertToDoc(
      'hooks:\n  PostToolUse:\n    - hooks:\n        - { command: ./x.sh }\n',
    );
    expect(Object.keys(doc.hooks)).toStrictEqual(['postToolUse']);
  });

  it('renames Stop → stop', () => {
    const doc = convertToDoc('hooks:\n  Stop:\n    - hooks:\n        - { command: ./x.sh }\n');
    expect(Object.keys(doc.hooks)).toStrictEqual(['stop']);
  });

  it('renames UserPromptSubmit → beforeSubmitPrompt', () => {
    const doc = convertToDoc(
      'hooks:\n  UserPromptSubmit:\n    - hooks:\n        - { command: ./x.sh }\n',
    );
    expect(Object.keys(doc.hooks)).toStrictEqual(['beforeSubmitPrompt']);
  });
});

describe('convertClaudeHooksYamlToCursorJson — tool-name translation', () => {
  it('translates Bash → Shell in the matcher', () => {
    const doc = convertToDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./x.sh }\n',
    );
    expect(doc.hooks.preToolUse?.[0]?.matcher).toBe('Shell');
  });

  it('keeps Read/Write/Edit/Grep matchers as identity', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'Grep']) {
      const doc = convertToDoc(
        `hooks:\n  PreToolUse:\n    - matcher: ${tool}\n      hooks:\n        - { command: ./x.sh }\n`,
      );
      expect(doc.hooks.preToolUse?.[0]?.matcher).toBe(tool);
    }
  });

  it('passes through unmapped matchers unchanged (Glob, mcp__*, arbitrary regex)', () => {
    for (const matcher of ['Glob', 'mcp__github__search', 'Notebook.*']) {
      const doc = convertToDoc(
        `hooks:\n  PreToolUse:\n    - matcher: "${matcher}"\n      hooks:\n        - { command: ./x.sh }\n`,
      );
      expect(doc.hooks.preToolUse?.[0]?.matcher).toBe(matcher);
    }
  });
});

// The shape adapter is event-agnostic, so these exercise it through an OBSERVER event
// (`PostToolUse`/`Stop`) where the emitted entries are byte-identical to the adapter output — the
// gating events additionally rewrite the `command` (covered by the shimmed-entries suite above).
describe('convertClaudeHooksYamlToCursorJson — shape adapter through the pipeline', () => {
  it('flattens multiple hooks[] entries under one matcher block into multiple flat entries', () => {
    const doc = convertToDoc(
      'hooks:\n  PostToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./a.sh }\n        - { command: ./b.sh }\n',
    );
    expect(doc.hooks.postToolUse).toStrictEqual([
      { command: './a.sh', matcher: 'Shell' },
      { command: './b.sh', matcher: 'Shell' },
    ]);
  });

  it('concatenates entries from multiple matcher blocks under one event', () => {
    const doc = convertToDoc(
      'hooks:\n  PostToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./a.sh }\n    - matcher: Read\n      hooks:\n        - { command: ./b.sh }\n',
    );
    expect(doc.hooks.postToolUse).toStrictEqual([
      { command: './a.sh', matcher: 'Shell' },
      { command: './b.sh', matcher: 'Read' },
    ]);
  });

  it('emits no matcher key for a matcher-less block and drops description', () => {
    const doc = convertToDoc(
      'hooks:\n  Stop:\n    - description: drop me\n      hooks:\n        - { command: ./p.sh }\n',
    );
    expect(doc.hooks.stop).toStrictEqual([{ command: './p.sh' }]);
  });
});

describe('convertClaudeHooksYamlToCursorJson — envelope + format', () => {
  it('wraps output in { version: 1, hooks: { … } }', () => {
    const doc = convertToDoc('hooks:\n  Stop:\n    - hooks:\n        - { command: ./x.sh }\n');
    expect(doc.version).toBe(1);
    expect(typeof doc.hooks).toBe('object');
  });

  it('outputs 2-space indented JSON with a trailing newline', () => {
    const out = convertClaudeHooksYamlToCursorJson(
      'hooks:\n  Stop:\n    - hooks:\n        - { command: ./x.sh }\n',
    );
    expect(out).toMatch(/^\{\n {2}"version": 1/);
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('convertClaudeHooksYamlToCursorJson — negatives', () => {
  it('throws on malformed YAML', () => {
    expect(() => convertClaudeHooksYamlToCursorJson(':\n  invalid: [\n  yaml')).toThrow();
  });

  it('drops a source event outside the four supported (SessionStart) rather than crashing', () => {
    const doc = convertToDoc(
      'hooks:\n  SessionStart:\n    - hooks:\n        - { command: ./s.sh }\n  Stop:\n    - hooks:\n        - { command: ./x.sh }\n',
    );
    // The unsupported event is absent; the supported one survives.
    expect(doc.hooks).not.toHaveProperty('SessionStart');
    expect(doc.hooks).not.toHaveProperty('sessionStart');
    expect(Object.keys(doc.hooks)).toStrictEqual(['stop']);
  });
});

// ---------------------------------------------------------------------------
// Worked example — byte-verbatim
//
// The source is `cursor-hooks-target.md` §3.2's worked example, but both its events (`PreToolUse`,
// `UserPromptSubmit`) are GATING, so the emitted `hooks/cursor.json` now flows through the
// controller shim (`cursor-controller-shim.md` §3.1): each entry's `command` invokes
// `hooks/cursor-shim.mjs`, carries the translated matcher, gains `failClosed: true`, and drops
// `type`. Expected JSON is hand-derived from §3.1 and serialized as canonical 2-space JSON.
// ---------------------------------------------------------------------------

/** Source `hooks/claude.yaml` (cursor-hooks-target.md §3.2 worked example — both events gating). */
const WORKED_EXAMPLE_YAML = `hooks:
  PreToolUse:
    - matcher: Bash
      description: guard shell
      hooks:
        - { type: command, command: ./guard.sh }
        - { type: command, command: ./log.sh }
  UserPromptSubmit:
    - hooks:
        - { type: command, command: ./prompt.sh }
`;

/**
 * Expected `hooks/cursor.json` body: both gating events are shimmed (cursor-controller-shim.md
 * §3.1). Serialized as canonical 2-space JSON — the byte form the transform emits.
 */
const WORKED_EXAMPLE_JSON = `{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs\\" preToolUse -- './guard.sh'",
        "matcher": "Shell",
        "failClosed": true
      },
      {
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs\\" preToolUse -- './log.sh'",
        "matcher": "Shell",
        "failClosed": true
      }
    ],
    "beforeSubmitPrompt": [
      {
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs\\" beforeSubmitPrompt -- './prompt.sh'",
        "failClosed": true
      }
    ]
  }
}
`;

describe('convertClaudeHooksYamlToCursorJson — worked example (shimmed gating events)', () => {
  it('produces the shimmed worked example verbatim', () => {
    expect(convertClaudeHooksYamlToCursorJson(WORKED_EXAMPLE_YAML)).toBe(WORKED_EXAMPLE_JSON);
  });
});

// ---------------------------------------------------------------------------
// Controller-hook shim — gating events (cursor-controller-shim.md §2.2, §3.1, §4)
//
// Expected values are hand-derived from cursor-controller-shim.md §3.1 (the shimmed-entry shape:
// `{ command: "node \"\${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs\" <cursorEvent> -- <handler>", matcher?, failClosed:
// true }`) — not captured from program output.
// @see docs/specs/cursor-controller-shim.md
// ---------------------------------------------------------------------------

/** A shimmed Cursor entry, including the `failClosed` flag the gating path adds. */
interface ShimmedCursorDoc {
  version: number;
  hooks: Record<
    string,
    { command: string; type?: string; matcher?: string; failClosed?: boolean }[]
  >;
}
function convertToShimDoc(yaml: string): ShimmedCursorDoc {
  return JSON.parse(convertClaudeHooksYamlToCursorJson(yaml)) as ShimmedCursorDoc;
}

describe('GATING_EVENTS — committed controller/observer split (§2.2)', () => {
  it('classifies PreToolUse and UserPromptSubmit as gating (controllers)', () => {
    expect(GATING_EVENTS.has('PreToolUse')).toBe(true);
    expect(GATING_EVENTS.has('UserPromptSubmit')).toBe(true);
  });

  it('classifies PostToolUse and Stop as NOT gating (observers)', () => {
    expect(GATING_EVENTS.has('PostToolUse')).toBe(false);
    expect(GATING_EVENTS.has('Stop')).toBe(false);
  });

  it('contains exactly the two gating events', () => {
    expect([...GATING_EVENTS].sort()).toStrictEqual(['PreToolUse', 'UserPromptSubmit']);
  });
});

describe('convertClaudeHooksYamlToCursorJson — shimmed gating entries (§3.1)', () => {
  it('rewrites a PreToolUse hook to a shim invocation with failClosed and translated matcher', () => {
    const doc = convertToShimDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { type: command, command: ./gate.sh }\n',
    );
    // §3.1: command → `node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" preToolUse -- '<handler>'`
    // (shim path anchored to the plugin root — issue #56; handler embedded as a single
    // POSIX-single-quoted token), matcher Bash→Shell, failClosed:true, and NO `type` key
    // (Cursor defaults it to command).
    expect(doc.hooks.preToolUse).toStrictEqual([
      {
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" preToolUse -- \'./gate.sh\'',
        matcher: 'Shell',
        failClosed: true,
      },
    ]);
  });

  it('anchors the shim path to "${CLAUDE_PLUGIN_ROOT}", never a cwd-relative path (issue #56)', () => {
    // Regression: 0.7.0 emitted `node ./hooks/cursor-shim.mjs …`, which assumed Cursor runs plugin
    // hook commands with cwd = plugin root. When that assumption fails, `node` exits "Cannot find
    // module" and — because the entry is failClosed — EVERY gated tool call is denied. The shim
    // path must be absolute via ${CLAUDE_PLUGIN_ROOT} (double-quoted for space-safe shell
    // expansion), matching Cursor's own guidance and every other emitted command.
    const doc = convertToShimDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./gate.sh }\n',
    );
    const command = doc.hooks.preToolUse?.[0]?.command;
    expect(command?.startsWith('node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" ')).toBe(true);
    expect(command).not.toContain('node ./hooks/');
  });

  it('rewrites a UserPromptSubmit hook (no matcher) to a beforeSubmitPrompt shim invocation', () => {
    const doc = convertToShimDoc(
      'hooks:\n  UserPromptSubmit:\n    - hooks:\n        - { type: command, command: ./prompt.sh }\n',
    );
    expect(doc.hooks.beforeSubmitPrompt).toStrictEqual([
      {
        command:
          'node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" beforeSubmitPrompt -- \'./prompt.sh\'',
        failClosed: true,
      },
    ]);
  });

  it('preserves a handler command with its own args as one quoted token across the `--` boundary', () => {
    const doc = convertToShimDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: "./gate.sh --strict foo" }\n',
    );
    // The handler's own args survive verbatim inside a single POSIX-single-quoted token after the
    // `--` sentinel (§3.1), so the shell hands the whole command to the runner as one argument.
    expect(doc.hooks.preToolUse?.[0]?.command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" preToolUse -- \'./gate.sh --strict foo\'',
    );
    expect(doc.hooks.preToolUse?.[0]?.failClosed).toBe(true);
  });

  it('POSIX-escapes a single quote in the handler command so it round-trips through one token', () => {
    // A handler command containing a single quote must be escaped as '\\'' (close, literal, reopen)
    // so shell tokenization keeps it a single argument (spec §3.1, shell fidelity).
    const doc = convertToShimDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: "./gate.sh --msg \'hi\'" }\n',
    );
    expect(doc.hooks.preToolUse?.[0]?.command).toBe(
      "node \"${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs\" preToolUse -- './gate.sh --msg '\\''hi'\\'''",
    );
  });

  it('shims every entry when a gating block has multiple hooks[]', () => {
    const doc = convertToShimDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./a.sh }\n        - { command: ./b.sh }\n',
    );
    expect(doc.hooks.preToolUse).toStrictEqual([
      {
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" preToolUse -- \'./a.sh\'',
        matcher: 'Shell',
        failClosed: true,
      },
      {
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" preToolUse -- \'./b.sh\'',
        matcher: 'Shell',
        failClosed: true,
      },
    ]);
  });
});

describe('convertClaudeHooksYamlToCursorJson — observer events stay byte-identical (§2.2 regression guard)', () => {
  it('leaves PostToolUse entries un-shimmed (no shim command, no failClosed, type preserved)', () => {
    const doc = convertToShimDoc(
      'hooks:\n  PostToolUse:\n    - matcher: Write\n      hooks:\n        - { type: command, command: ./log.sh }\n',
    );
    expect(doc.hooks.postToolUse).toStrictEqual([
      { command: './log.sh', type: 'command', matcher: 'Write' },
    ]);
    expect(doc.hooks.postToolUse?.[0]).not.toHaveProperty('failClosed');
  });

  it('leaves Stop entries un-shimmed', () => {
    const doc = convertToShimDoc(
      'hooks:\n  Stop:\n    - hooks:\n        - { type: command, command: ./cleanup.sh }\n',
    );
    expect(doc.hooks.stop).toStrictEqual([{ command: './cleanup.sh', type: 'command' }]);
    expect(doc.hooks.stop?.[0]).not.toHaveProperty('failClosed');
  });
});

describe('cursorDocHasGatingHook — build gating-hook predicate over the converted doc (§3.3)', () => {
  /** Convert source YAML to the parsed Cursor doc, exactly as the build does (single parse). */
  function toDoc(yaml: string): unknown {
    return JSON.parse(convertClaudeHooksYamlToCursorJson(yaml)) as unknown;
  }

  it('is true when a PreToolUse hook is present', () => {
    expect(
      cursorDocHasGatingHook(
        toDoc('hooks:\n  PreToolUse:\n    - hooks:\n        - { command: ./g.sh }\n'),
      ),
    ).toBe(true);
  });

  it('is true when a UserPromptSubmit hook is present', () => {
    expect(
      cursorDocHasGatingHook(
        toDoc('hooks:\n  UserPromptSubmit:\n    - hooks:\n        - { command: ./p.sh }\n'),
      ),
    ).toBe(true);
  });

  it('is false for observer-only sources (PostToolUse/Stop)', () => {
    expect(
      cursorDocHasGatingHook(
        toDoc(
          'hooks:\n  PostToolUse:\n    - matcher: Write\n      hooks:\n        - { command: ./log.sh }\n  Stop:\n    - hooks:\n        - { command: ./c.sh }\n',
        ),
      ),
    ).toBe(false);
  });

  it('is false when a gating event has no emittable entry (empty/commandless block)', () => {
    expect(
      cursorDocHasGatingHook(
        toDoc('hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks: []\n'),
      ),
    ).toBe(false);
  });

  it('is false for non-object / malformed input (defensive)', () => {
    expect(cursorDocHasGatingHook(undefined)).toBe(false);
    expect(cursorDocHasGatingHook(null)).toBe(false);
    expect(cursorDocHasGatingHook('not a doc')).toBe(false);
    expect(cursorDocHasGatingHook({})).toBe(false);
    expect(cursorDocHasGatingHook({ hooks: null })).toBe(false);
  });
});
