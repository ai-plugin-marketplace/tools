/**
 * Tests for the Kiro target mechanical transformations (transform.ts).
 *
 * Uses real agent .md content from the skill-evaluator plugin in the template
 * repository to validate parity with `buildKiroAgentJson` in build-standalone.ts.
 *
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/src/build-standalone.ts
 * @see /Users/mnorth/Development/ai-plugin-marketplace-template/plugins/skill-evaluator/agents/
 * @see docs/specs/architecture.md §7, §7.1
 */

import { describe, expect, it } from 'vitest';
import { kiroAgentConfigSchema } from './schemas.js';
import {
  buildKiroAgentConfig,
  CLAUDE_TO_KIRO_TOOLS,
  translateAgentTools,
  translateToolName,
} from './transform.js';

// ---------------------------------------------------------------------------
// Test fixtures — real agent .md content from skill-evaluator
// ---------------------------------------------------------------------------

/**
 * Verbatim content of plugins/skill-evaluator/agents/experimenter.md from the
 * template repository. Used to validate parity with the current buildKiroAgentJson.
 */
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

You are the experimenter in a blind skill evaluation. Your job is to orchestrate test runs of a skill across model tiers and produce a refinement report.

## Principles

- **Blind testing**: Never reveal expected outcomes to test subjects
- **Structured protocol**: Define pass/fail criteria BEFORE running tests
- **Systematic comparison**: Evaluate each tier independently before comparing across tiers
- **Actionable output**: Every identified failure must include a specific recommendation

## Workflow

1. Receive the skill content and test cases from the evaluate-skill skill
2. For each model tier (opus, sonnet, haiku):
   a. For each test case, spawn a test-subject agent at the appropriate tier
   b. Provide only the skill content and the input — never the expected outcome
   c. Collect and store the output
3. Compare outputs against expected outcomes
4. Generate a structured refinement report

## Report Format

\`\`\`
# Skill Evaluation Report

## Summary
- Skill: [name]
- Clarity Floor: [lowest passing tier]
- Overall Pass Rate: [X/Y]

## Per-Tier Results
### Opus
| Test Case | Pass/Fail | Notes |
|-----------|-----------|-------|
| ...       | ...       | ...   |

### Sonnet
...

### Haiku
...

## Failure Analysis
### [Test Case N at Tier X]
- **Symptom**: [what went wrong]
- **Root Cause**: [why the lower-tier agent failed]
- **Recommendation**: [specific improvement to the skill]

## Recommendations
1. [Ordered list of improvements, highest impact first]
\`\`\`
`;

/**
 * Verbatim content of plugins/skill-evaluator/agents/test-subject.md from the
 * template repository.
 */
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

<!-- The model tier above (\`sonnet\`) is a default. The experimenter agent typically overrides this when spawning test subjects at different tiers (opus → sonnet → haiku). -->

You are a test subject in a blind skill evaluation. You will receive a skill and an input. Execute the skill to the best of your ability and produce your output.

## Rules

- You do NOT know what the expected outcome is — just do your best
- Follow the skill instructions exactly as written
- If the skill instructions are ambiguous, make your best interpretation and note the ambiguity
- Do not ask clarifying questions — work with what you have
- Produce your output in a clear, structured format

## Process

1. Read the skill content provided to you
2. Read the input provided to you
3. Execute the skill's instructions against the input
4. Produce your output

## Output Format

Produce your result in this format:

\`\`\`
## Output

[Your skill execution output here]

## Notes

- [Any ambiguities encountered]
- [Assumptions made]
- [Difficulties faced]
\`\`\`
`;

// ---------------------------------------------------------------------------
// CLAUDE_TO_KIRO_TOOLS table
// ---------------------------------------------------------------------------

describe('CLAUDE_TO_KIRO_TOOLS', () => {
  it('contains exactly the 7 mappings from build-standalone.ts', () => {
    // Verify every key from the reference implementation is present and correct.
    // Ported byte-for-byte from CLAUDE_TO_KIRO_TOOLS in build-standalone.ts.
    expect(Object.keys(CLAUDE_TO_KIRO_TOOLS)).toHaveLength(7);
    expect(CLAUDE_TO_KIRO_TOOLS.Read).toBe('read');
    expect(CLAUDE_TO_KIRO_TOOLS.Write).toBe('write');
    expect(CLAUDE_TO_KIRO_TOOLS.Edit).toBe('write');
    expect(CLAUDE_TO_KIRO_TOOLS.Glob).toBe('glob');
    expect(CLAUDE_TO_KIRO_TOOLS.Grep).toBe('grep');
    expect(CLAUDE_TO_KIRO_TOOLS.Bash).toBe('shell');
    expect(CLAUDE_TO_KIRO_TOOLS.Agent).toBe('delegate');
  });
});

// ---------------------------------------------------------------------------
// translateToolName
// ---------------------------------------------------------------------------

describe('translateToolName', () => {
  it('translates Read → read', () => {
    expect(translateToolName('Read')).toBe('read');
  });

  it('translates Write → write', () => {
    expect(translateToolName('Write')).toBe('write');
  });

  it('translates Edit → write', () => {
    expect(translateToolName('Edit')).toBe('write');
  });

  it('translates Glob → glob', () => {
    expect(translateToolName('Glob')).toBe('glob');
  });

  it('translates Grep → grep', () => {
    expect(translateToolName('Grep')).toBe('grep');
  });

  it('translates Bash → shell', () => {
    expect(translateToolName('Bash')).toBe('shell');
  });

  it('translates Agent → delegate', () => {
    expect(translateToolName('Agent')).toBe('delegate');
  });

  it('returns undefined for an unknown tool name', () => {
    expect(translateToolName('UnknownTool')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(translateToolName('')).toBeUndefined();
  });

  it('returns undefined for lowercase claude names (case-sensitive)', () => {
    // The table is PascalCase keys only.
    expect(translateToolName('read')).toBeUndefined();
    expect(translateToolName('bash')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translateAgentTools
// ---------------------------------------------------------------------------

describe('translateAgentTools', () => {
  it('translates and deduplicates a mixed list', () => {
    // Read and Edit both map to their respective Kiro names, with dedup applied.
    expect(translateAgentTools(['Read', 'Read', 'Edit'])).toEqual(['read', 'write']);
  });

  it('silently drops unknown tool names', () => {
    expect(translateAgentTools(['UnknownTool', 'Read'])).toEqual(['read']);
  });

  it('deduplicates when two Claude names map to the same Kiro name (Edit and Write → write)', () => {
    expect(translateAgentTools(['Write', 'Edit'])).toEqual(['write']);
  });

  it('returns an empty array for an empty input', () => {
    expect(translateAgentTools([])).toEqual([]);
  });

  it('returns an empty array when all tools are unknown', () => {
    expect(translateAgentTools(['Foo', 'Bar', 'Baz'])).toEqual([]);
  });

  it('preserves first-seen order for distinct mappings', () => {
    expect(translateAgentTools(['Agent', 'Read', 'Bash'])).toEqual(['delegate', 'read', 'shell']);
  });
});

// ---------------------------------------------------------------------------
// buildKiroAgentConfig
// ---------------------------------------------------------------------------

describe('buildKiroAgentConfig', () => {
  it('returns null for content with no frontmatter', () => {
    const result = buildKiroAgentConfig(
      '# Just a markdown body\n\nNo frontmatter here.',
      'my-agent',
    );
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(buildKiroAgentConfig('', 'my-agent')).toBeNull();
  });

  it('uses fallbackName when frontmatter has no name field', () => {
    const md = `---
description: An agent with no name
tools:
  - Read
---

Body text.
`;
    const result = buildKiroAgentConfig(md, 'my-fallback');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('my-fallback');
  });

  it('uses frontmatter name over fallbackName when present', () => {
    const md = `---
name: explicit-name
description: An agent
---

Body.
`;
    const result = buildKiroAgentConfig(md, 'fallback');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('explicit-name');
  });

  it('sets description to empty string when frontmatter has no description field', () => {
    const md = `---
name: no-description-agent
---

Body.
`;
    const result = buildKiroAgentConfig(md, 'no-description-agent');
    expect(result).not.toBeNull();
    expect(result?.description).toBe('');
  });

  it('produces correct defaults for mcpServers, toolAliases, allowedTools, resources, hooks, toolsSettings, includeMcpJson, model', () => {
    const md = `---
name: simple
description: Simple agent
---

Body.
`;
    const result = buildKiroAgentConfig(md, 'simple');
    expect(result).not.toBeNull();
    expect(result?.mcpServers).toEqual({});
    expect(result?.toolAliases).toEqual({});
    expect(result?.allowedTools).toEqual([]);
    expect(result?.resources).toEqual([]);
    expect(result?.hooks).toEqual({});
    expect(result?.toolsSettings).toEqual({});
    expect(result?.includeMcpJson).toBe(true);
    expect(result?.model).toBeNull();
  });

  it('produces a schema-valid KiroAgentConfig for experimenter.md', () => {
    const result = buildKiroAgentConfig(EXPERIMENTER_MD, 'experimenter');
    expect(result).not.toBeNull();

    // Validate against kiroAgentConfigSchema — proves schema compatibility
    const parsed = kiroAgentConfigSchema.parse(result);
    expect(parsed.name).toBe('experimenter');
    expect(parsed.description).toBe('Orchestrates blind skill evaluation across model tiers');
    expect(parsed.model).toBeNull();
  });

  it('produces correct translated tools for experimenter.md (Agent,Read,Write,Glob,Grep,Bash)', () => {
    const result = buildKiroAgentConfig(EXPERIMENTER_MD, 'experimenter');
    expect(result).not.toBeNull();
    // Agent→delegate, Read→read, Write→write, Glob→glob, Grep→grep, Bash→shell
    // Order matches first-seen order in the frontmatter tools block.
    expect(result?.tools).toEqual(['delegate', 'read', 'write', 'glob', 'grep', 'shell']);
  });

  it('produces the exact tools list from the oracle experimenter.json', () => {
    // Oracle: dist/kiro/skill-evaluator/.kiro/agents/experimenter.json
    // tools: ["delegate", "read", "write", "glob", "grep", "shell"]
    const result = buildKiroAgentConfig(EXPERIMENTER_MD, 'experimenter');
    expect(result?.tools).toEqual(['delegate', 'read', 'write', 'glob', 'grep', 'shell']);
  });

  it('produces correct translated tools for test-subject.md (Read,Write,Bash,Glob,Grep,Edit)', () => {
    const result = buildKiroAgentConfig(TEST_SUBJECT_MD, 'test-subject');
    expect(result).not.toBeNull();
    // Read→read, Write→write, Bash→shell, Glob→glob, Grep→grep, Edit→write (deduped)
    // Oracle: ["read", "write", "shell", "glob", "grep"]
    expect(result?.tools).toEqual(['read', 'write', 'shell', 'glob', 'grep']);
  });

  it('produces the exact prompt body for experimenter.md (trimmed body)', () => {
    const result = buildKiroAgentConfig(EXPERIMENTER_MD, 'experimenter');
    expect(result).not.toBeNull();
    // Prompt is everything after the closing --- fence, trimmed
    expect(result?.prompt).toMatch(/^# Experimenter Agent/);
    expect(result?.prompt).not.toMatch(/^---/);
  });

  it('produces a schema-valid KiroAgentConfig for test-subject.md', () => {
    const result = buildKiroAgentConfig(TEST_SUBJECT_MD, 'test-subject');
    expect(result).not.toBeNull();

    const parsed = kiroAgentConfigSchema.parse(result);
    expect(parsed.name).toBe('test-subject');
    expect(parsed.description).toBe(
      'Blind agent that executes a skill and produces output without knowledge of expected outcomes',
    );
  });
});
