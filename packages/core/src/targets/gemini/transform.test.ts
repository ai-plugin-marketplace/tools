/**
 * Tests for Gemini CLI target mechanical transformations.
 *
 * Covers `CLAUDE_TO_GEMINI_TOOLS`, `translateToolName`, and
 * `rewriteAgentFrontmatterTools`. All functions under test are pure (no I/O).
 *
 * @see docs/specs/architecture.md §7 (mechanical transformations)
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-standalone.ts
 *      (authoritative source of the lookup table — must match byte-for-byte)
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_TO_GEMINI_TOOLS,
  rewriteAgentFrontmatterTools,
  translateToolName,
} from './transform.js';

// ---------------------------------------------------------------------------
// CLAUDE_TO_GEMINI_TOOLS — exact parity with build-standalone.ts
// ---------------------------------------------------------------------------

describe('CLAUDE_TO_GEMINI_TOOLS', () => {
  it('maps Read → read_file', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Read).toBe('read_file');
  });

  it('maps Write → write_file', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Write).toBe('write_file');
  });

  it('maps Edit → replace', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Edit).toBe('replace');
  });

  it('maps Glob → glob', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Glob).toBe('glob');
  });

  it('maps Grep → search_file_content', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Grep).toBe('search_file_content');
  });

  it('maps Bash → run_shell_command', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Bash).toBe('run_shell_command');
  });

  it('maps Agent → activate_skill', () => {
    expect(CLAUDE_TO_GEMINI_TOOLS.Agent).toBe('activate_skill');
  });

  it('contains exactly the seven canonical mappings (no additions, no omissions)', () => {
    expect(Object.keys(CLAUDE_TO_GEMINI_TOOLS).sort()).toStrictEqual([
      'Agent',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
  });
});

// ---------------------------------------------------------------------------
// translateToolName
// ---------------------------------------------------------------------------

describe('translateToolName', () => {
  it('translates a known Claude tool name to its Gemini equivalent', () => {
    expect(translateToolName('Read')).toBe('read_file');
  });

  it('returns undefined for an unknown tool name', () => {
    expect(translateToolName('NonExistent')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(translateToolName('')).toBeUndefined();
  });

  it('is case-sensitive (lowercase "read" is not a known mapping)', () => {
    expect(translateToolName('read')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rewriteAgentFrontmatterTools — with real skill-evaluator agent content
// ---------------------------------------------------------------------------

/** Frontmatter from plugins/skill-evaluator/agents/experimenter.md */
const EXPERIMENTER_MD = `---
name: experimenter
description: Orchestrates blind skill evaluation across model tiers
tools:
  - Agent
  - Read
  - Write
  - Glob
  - Grep
  - Bash
model: opus
---

# Experimenter Agent

Body content here.
`;

/** Frontmatter from plugins/skill-evaluator/agents/test-subject.md */
const TEST_SUBJECT_MD = `---
name: test-subject
description: Blind agent that executes a skill and produces output without knowledge of expected outcomes
model: sonnet
tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Edit
---

# Test Subject Agent

Body content here.
`;

describe('rewriteAgentFrontmatterTools', () => {
  it('rewrites all tools in the experimenter agent to Gemini snake_case names', () => {
    const { content, droppedTools } = rewriteAgentFrontmatterTools(EXPERIMENTER_MD);

    expect(droppedTools).toStrictEqual([]);
    expect(content).toContain('  - activate_skill');
    expect(content).toContain('  - read_file');
    expect(content).toContain('  - write_file');
    expect(content).toContain('  - glob');
    expect(content).toContain('  - search_file_content');
    expect(content).toContain('  - run_shell_command');
    // Original Claude names must be gone
    expect(content).not.toContain('  - Agent');
    expect(content).not.toContain('  - Read');
    expect(content).not.toContain('  - Write');
  });

  it('rewrites all tools in the test-subject agent (includes Edit)', () => {
    const { content, droppedTools } = rewriteAgentFrontmatterTools(TEST_SUBJECT_MD);

    expect(droppedTools).toStrictEqual([]);
    expect(content).toContain('  - read_file');
    expect(content).toContain('  - write_file');
    expect(content).toContain('  - run_shell_command');
    expect(content).toContain('  - glob');
    expect(content).toContain('  - search_file_content');
    expect(content).toContain('  - replace');
    expect(content).not.toContain('  - Edit');
  });

  it('preserves non-tools frontmatter fields and body unchanged', () => {
    const { content } = rewriteAgentFrontmatterTools(EXPERIMENTER_MD);

    expect(content).toContain('name: experimenter');
    expect(content).toContain(
      'description: Orchestrates blind skill evaluation across model tiers',
    );
    expect(content).toContain('model: opus');
    expect(content).toContain('# Experimenter Agent');
    expect(content).toContain('Body content here.');
  });

  it('returns content unchanged and droppedTools: [] when there is no frontmatter', () => {
    const noFrontmatter = '# Just a plain markdown file\n\nNo frontmatter here.\n';
    const { content, droppedTools } = rewriteAgentFrontmatterTools(noFrontmatter);

    expect(content).toBe(noFrontmatter);
    expect(droppedTools).toStrictEqual([]);
  });

  it('returns content unchanged and droppedTools: [] when frontmatter has no tools: key', () => {
    const noTools = `---
name: my-agent
description: An agent without tools
model: sonnet
---

Body.
`;
    const { content, droppedTools } = rewriteAgentFrontmatterTools(noTools);

    expect(content).toBe(noTools);
    expect(droppedTools).toStrictEqual([]);
  });

  it('emits tools: [] and populates droppedTools when every tool is unmapped', () => {
    const allUnknown = `---
name: test
description: test
tools:
  - FakeToolA
  - FakeToolB
---

Body.
`;
    const { content, droppedTools } = rewriteAgentFrontmatterTools(allUnknown);

    expect(droppedTools).toStrictEqual(['FakeToolA', 'FakeToolB']);
    expect(content).toContain('tools: []');
    expect(content).not.toContain('  - FakeToolA');
    expect(content).not.toContain('  - FakeToolB');
  });

  it('drops only unmapped tools and reports them in droppedTools', () => {
    const mixed = `---
name: test
description: test
tools:
  - Read
  - UnknownTool
  - Bash
---

Body.
`;
    const { content, droppedTools } = rewriteAgentFrontmatterTools(mixed);

    expect(droppedTools).toStrictEqual(['UnknownTool']);
    expect(content).toContain('  - read_file');
    expect(content).toContain('  - run_shell_command');
    expect(content).not.toContain('  - UnknownTool');
  });

  it('returns no dropped tools when every Claude tool has a mapping (all seven tools)', () => {
    const allMapped = `---
name: full-agent
description: Uses all mapped tools
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
---

Body.
`;
    const { droppedTools } = rewriteAgentFrontmatterTools(allMapped);
    expect(droppedTools).toStrictEqual([]);
  });
});
