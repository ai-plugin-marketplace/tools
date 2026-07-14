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
  adaptMatcherBlockToCursorEntries,
  convertClaudeHooksYamlToCursorJson,
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

describe('convertClaudeHooksYamlToCursorJson — shape adapter through the pipeline', () => {
  it('flattens multiple hooks[] entries under one matcher block into multiple flat entries', () => {
    const doc = convertToDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./a.sh }\n        - { command: ./b.sh }\n',
    );
    expect(doc.hooks.preToolUse).toStrictEqual([
      { command: './a.sh', matcher: 'Shell' },
      { command: './b.sh', matcher: 'Shell' },
    ]);
  });

  it('concatenates entries from multiple matcher blocks under one event', () => {
    const doc = convertToDoc(
      'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - { command: ./a.sh }\n    - matcher: Read\n      hooks:\n        - { command: ./b.sh }\n',
    );
    expect(doc.hooks.preToolUse).toStrictEqual([
      { command: './a.sh', matcher: 'Shell' },
      { command: './b.sh', matcher: 'Read' },
    ]);
  });

  it('emits no matcher key for a matcher-less block and drops description', () => {
    const doc = convertToDoc(
      'hooks:\n  UserPromptSubmit:\n    - description: drop me\n      hooks:\n        - { command: ./p.sh }\n',
    );
    expect(doc.hooks.beforeSubmitPrompt).toStrictEqual([{ command: './p.sh' }]);
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
// Worked example (spec §3.2 / issue #34) — byte-verbatim
// ---------------------------------------------------------------------------

/** Source `hooks/claude.yaml` from the spec's worked example (§3.2). */
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
 * Expected `hooks/cursor.json` body, hand-derived from the spec's worked-example object and
 * serialized as canonical 2-space JSON (the byte form the transform emits — the spec's markdown
 * shows a Prettier-compacted rendering of the same object).
 */
const WORKED_EXAMPLE_JSON = `{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "./guard.sh",
        "type": "command",
        "matcher": "Shell"
      },
      {
        "command": "./log.sh",
        "type": "command",
        "matcher": "Shell"
      }
    ],
    "beforeSubmitPrompt": [
      {
        "command": "./prompt.sh",
        "type": "command"
      }
    ]
  }
}
`;

describe('convertClaudeHooksYamlToCursorJson — spec worked example', () => {
  it('produces the spec worked example verbatim', () => {
    expect(convertClaudeHooksYamlToCursorJson(WORKED_EXAMPLE_YAML)).toBe(WORKED_EXAMPLE_JSON);
  });
});
