/**
 * Tests for Claude Code target mechanical transformations.
 *
 * Round-trip test data is sourced from the `skill-evaluator` plugin in the template repo
 * (`plugins/skill-evaluator/hooks/claude.yaml`). The expected JSON structure is derived
 * by hand from the YAML source — not from running the program — per the spec-first testing rule.
 *
 * @see docs/specs/architecture.md §7.2 (Claude hooks transformation)
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  convertClaudeHooksYamlToJson,
  parseClaudeHooksYaml,
  serializeClaudeHooksJson,
} from './transform.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Exact content of `plugins/skill-evaluator/hooks/claude.yaml` from the template repo.
 * The folded scalar (`>-`) collapses the multi-line shell command into a single line.
 */
const SKILL_EVALUATOR_YAML = `hooks:
  PostToolUse:
    - matcher: Write
      description: Log evaluation report writes to a structured log file
      hooks:
        - type: command
          command: >-
            if echo "$TOOL_INPUT" | grep -q 'evaluation-report';
            then echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Evaluation report written"
            >> .evaluation-log.jsonl; fi
`;

/**
 * The expected parsed structure for SKILL_EVALUATOR_YAML.
 * Derived from the YAML spec — the `>-` folded scalar joins the three command lines with
 * single spaces and strips the trailing newline.
 */
const SKILL_EVALUATOR_PARSED = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Write',
        description: 'Log evaluation report writes to a structured log file',
        hooks: [
          {
            type: 'command' as const,
            command:
              'if echo "$TOOL_INPUT" | grep -q \'evaluation-report\'; then echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Evaluation report written" >> .evaluation-log.jsonl; fi',
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// parseClaudeHooksYaml
// ---------------------------------------------------------------------------

describe('parseClaudeHooksYaml', () => {
  it('parses the skill-evaluator YAML into the expected typed structure', () => {
    const result = parseClaudeHooksYaml(SKILL_EVALUATOR_YAML);
    expect(result).toEqual(SKILL_EVALUATOR_PARSED);
  });

  it('parses a minimal single-hook example into the expected typed object', () => {
    const yaml = `hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: echo hello
`;
    const result = parseClaudeHooksYaml(yaml);
    expect(result).toEqual({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo hello' }],
          },
        ],
      },
    });
  });

  it('accepts an empty hooks object (empty is valid per the schema)', () => {
    const yaml = 'hooks: {}\n';
    const result = parseClaudeHooksYaml(yaml);
    expect(result).toEqual({ hooks: {} });
  });

  it('throws on malformed YAML (unbalanced quotes)', () => {
    const badYaml = 'hooks:\n  key: "unterminated\n';
    expect(() => parseClaudeHooksYaml(badYaml)).toThrow();
  });

  it('throws ZodError for YAML that parses but uses an unknown hook event name', () => {
    const yaml = `hooks:
  OnFileChange:
    - hooks:
        - type: command
          command: echo bad
`;
    expect(() => parseClaudeHooksYaml(yaml)).toThrow(ZodError);
  });

  it('throws ZodError for a hook entry missing the required type: "command" field', () => {
    const yaml = `hooks:
  PostToolUse:
    - hooks:
        - command: echo missing-type
`;
    expect(() => parseClaudeHooksYaml(yaml)).toThrow(ZodError);
  });

  it('throws ZodError for a hook entry with an invalid type value', () => {
    const yaml = `hooks:
  PostToolUse:
    - hooks:
        - type: shell
          command: echo wrong-type
`;
    expect(() => parseClaudeHooksYaml(yaml)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// serializeClaudeHooksJson
// ---------------------------------------------------------------------------

describe('serializeClaudeHooksJson', () => {
  it('emits 2-space indentation matching build-hooks.ts output (JSON.stringify + 2-space + trailing newline)', () => {
    const result = serializeClaudeHooksJson(SKILL_EVALUATOR_PARSED);
    // Verify it ends with exactly one newline
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
    // Verify 2-space indentation is used (first indented key)
    expect(result).toContain('  "hooks"');
  });

  it('round-trips: serialized JSON parses back to the original data', () => {
    const json = serializeClaudeHooksJson(SKILL_EVALUATOR_PARSED);
    expect(JSON.parse(json)).toEqual(SKILL_EVALUATOR_PARSED);
  });

  it('serializes an empty hooks object', () => {
    const result = serializeClaudeHooksJson({ hooks: {} });
    expect(result).toBe('{\n  "hooks": {}\n}\n');
  });
});

// ---------------------------------------------------------------------------
// convertClaudeHooksYamlToJson (round-trip)
// ---------------------------------------------------------------------------

describe('convertClaudeHooksYamlToJson', () => {
  it('round-trip: skill-evaluator YAML produces JSON that parses to the expected structure', () => {
    const json = convertClaudeHooksYamlToJson(SKILL_EVALUATOR_YAML);
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toEqual(SKILL_EVALUATOR_PARSED);
  });

  it('produces output ending with a trailing newline', () => {
    const json = convertClaudeHooksYamlToJson(SKILL_EVALUATOR_YAML);
    expect(json.endsWith('\n')).toBe(true);
  });

  it('throws on malformed YAML input', () => {
    expect(() => convertClaudeHooksYamlToJson('hooks:\n  key: "bad\n')).toThrow();
  });

  it('throws ZodError when YAML parses but violates the hooks schema (unknown event)', () => {
    const yaml = `hooks:
  InvalidEvent:
    - hooks:
        - type: command
          command: echo bad
`;
    expect(() => convertClaudeHooksYamlToJson(yaml)).toThrow(ZodError);
  });

  it('succeeds for YAML with an empty hooks object', () => {
    const result = convertClaudeHooksYamlToJson('hooks: {}\n');
    expect(JSON.parse(result)).toEqual({ hooks: {} });
  });
});
