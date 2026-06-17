/**
 * Tests for Claude Code target Zod schemas.
 *
 * Positive test data is modelled on the `skill-evaluator` plugin in the template repo.
 * Negative tests cover the most likely author mistakes for each schema.
 *
 * @see https://raw.githubusercontent.com/ai-plugin-marketplace-template/main/schemas/plugin.json
 */

import { describe, expect, it } from 'vitest';
import {
  claudeAgentFrontmatterSchema,
  claudeHookEntrySchema,
  claudeHookMatcherSchema,
  claudeHooksFileSchema,
  claudeMcpConfigSchema,
  claudePluginManifestSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Assert that `.safeParse` returns an error (negative test helper). */
function expectInvalid(
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown,
): void {
  const result = schema.safeParse(value);
  expect(result.success, `expected schema to reject ${JSON.stringify(value)}`).toBe(false);
}

// ---------------------------------------------------------------------------
// claudePluginManifestSchema
// ---------------------------------------------------------------------------

describe('claudePluginManifestSchema', () => {
  const minimalValid = { name: 'skill-evaluator' };

  const realisticValid = {
    name: 'skill-evaluator',
    version: '0.0.1',
    description:
      'Evaluate AI skills across model tiers with blind testing and refinement recommendations',
    author: { name: 'AI Plugin Marketplace Template' },
    keywords: ['evaluation', 'testing', 'skills', 'model-tiers'],
    skills: ['./skills/evaluate-skill'],
    agents: ['./agents/experimenter.md', './agents/test-subject.md'],
    commands: ['./commands/evaluate.md'],
    hooks: './hooks/claude.json',
  };

  it('accepts a minimal manifest (name only)', () => {
    const result = claudePluginManifestSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it('accepts a realistic full manifest modelled on skill-evaluator', () => {
    const result = claudePluginManifestSchema.safeParse(realisticValid);
    expect(result.success).toBe(true);
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an inline hooks object', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      hooks: { hooks: { PreToolUse: [] } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a record of commands', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      commands: { evaluate: { description: 'run eval' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts mcpServers as a ./ path string', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      mcpServers: './.mcp.json',
    });
    expect(result.success).toBe(true);
  });

  it('accepts mcpServers as an inline record', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      mcpServers: { myserver: { command: 'node', args: ['server.js'] } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an author with all optional fields', () => {
    const result = claudePluginManifestSchema.safeParse({
      ...minimalValid,
      author: { name: 'Jane', email: 'jane@example.com', url: 'https://example.com' },
    });
    expect(result.success).toBe(true);
  });

  // --- negative tests ---

  it('rejects a missing name field', () => {
    expectInvalid(claudePluginManifestSchema, { version: '1.0.0' });
  });

  it('rejects a name with uppercase letters', () => {
    expectInvalid(claudePluginManifestSchema, { name: 'Skill-Evaluator' });
  });

  it('rejects a name that starts with a digit', () => {
    expectInvalid(claudePluginManifestSchema, { name: '1skill' });
  });

  it('rejects an unknown top-level field (confirms strictness)', () => {
    expectInvalid(claudePluginManifestSchema, { name: 'my-plugin', unknownField: true });
  });

  it('rejects an agent path that does not end in .md', () => {
    expectInvalid(claudePluginManifestSchema, {
      name: 'my-plugin',
      agents: './agents/my-agent.yaml',
    });
  });

  it('rejects a hooks path that does not start with ./', () => {
    expectInvalid(claudePluginManifestSchema, { name: 'my-plugin', hooks: 'hooks/claude.json' });
  });

  it('rejects an mcpServers path that does not start with ./', () => {
    expectInvalid(claudePluginManifestSchema, { name: 'my-plugin', mcpServers: '.mcp.json' });
  });

  it('rejects an mcpServers path that is not a .json file', () => {
    expectInvalid(claudePluginManifestSchema, { name: 'my-plugin', mcpServers: './mcp.txt' });
  });

  it('rejects an author with an unknown field (strict sub-object)', () => {
    expectInvalid(claudePluginManifestSchema, {
      name: 'my-plugin',
      author: { name: 'Jane', github: 'janedoe' },
    });
  });
});

// ---------------------------------------------------------------------------
// claudeMcpConfigSchema
// ---------------------------------------------------------------------------

describe('claudeMcpConfigSchema', () => {
  const minimalValid = { mcpServers: {} };

  const realisticValid = {
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['./server.js'],
        env: { API_KEY: 'abc123' },
      },
    },
  };

  it('accepts an empty mcpServers record (as in skill-evaluator)', () => {
    const result = claudeMcpConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it('accepts a realistic server config with command, args, env', () => {
    const result = claudeMcpConfigSchema.safeParse(realisticValid);
    expect(result.success).toBe(true);
  });

  it('accepts a server with only a command (args and env optional)', () => {
    const result = claudeMcpConfigSchema.safeParse({
      mcpServers: { minimal: { command: 'npx my-mcp-server' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = claudeMcpConfigSchema.safeParse({ ...minimalValid, schemaVersion: '0.1.0' });
    expect(result.success).toBe(true);
  });

  // --- negative tests ---

  it('rejects a missing mcpServers field', () => {
    expectInvalid(claudeMcpConfigSchema, {});
  });

  it('rejects a server entry missing command', () => {
    expectInvalid(claudeMcpConfigSchema, {
      mcpServers: { bad: { args: ['--help'] } },
    });
  });

  it('rejects an unknown top-level field (confirms strictness)', () => {
    expectInvalid(claudeMcpConfigSchema, { mcpServers: {}, extraField: true });
  });

  it('rejects a server entry with an unknown field (confirms server strictness)', () => {
    expectInvalid(claudeMcpConfigSchema, {
      mcpServers: {
        bad: { command: 'node', unknownOption: true },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// claudeHooksFileSchema
// ---------------------------------------------------------------------------

describe('claudeHooksFileSchema', () => {
  const realisticValid = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write',
          description: 'Log evaluation report writes to a structured log file',
          hooks: [
            {
              type: 'command' as const,
              command: 'echo "file written"',
            },
          ],
        },
      ],
    },
  };

  it('accepts a realistic hooks file modelled on skill-evaluator', () => {
    const result = claudeHooksFileSchema.safeParse(realisticValid);
    expect(result.success).toBe(true);
  });

  it('accepts all four valid event types', () => {
    const result = claudeHooksFileSchema.safeParse({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a matcher with no optional fields (only required hooks array)', () => {
    const result = claudeHooksFileSchema.safeParse({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = claudeHooksFileSchema.safeParse({ ...realisticValid, schemaVersion: '0.1.0' });
    expect(result.success).toBe(true);
  });

  // --- negative tests ---

  it('rejects an unknown hook event type', () => {
    expectInvalid(claudeHooksFileSchema, {
      hooks: { OnFileChange: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    });
  });

  it('rejects a hook entry with a wrong type value', () => {
    expectInvalid(claudeHooksFileSchema, {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'shell', command: 'echo bad' }] }],
      },
    });
  });

  it('rejects a matcher with an unknown field (confirms strictness)', () => {
    expectInvalid(claudeHooksFileSchema, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo x' }], unknownKey: true }],
      },
    });
  });

  it('rejects a hook entry missing command', () => {
    expectInvalid(claudeHooksFileSchema, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command' }] }],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// claudeHookEntrySchema (sub-schema unit tests)
// ---------------------------------------------------------------------------

describe('claudeHookEntrySchema', () => {
  it('accepts a valid command entry', () => {
    expect(claudeHookEntrySchema.safeParse({ type: 'command', command: 'echo hi' }).success).toBe(
      true,
    );
  });

  it('rejects an entry with a wrong type', () => {
    expectInvalid(claudeHookEntrySchema, { type: 'script', command: 'echo hi' });
  });

  it('rejects an entry with an extra field (confirms strictness)', () => {
    expectInvalid(claudeHookEntrySchema, { type: 'command', command: 'echo hi', extra: true });
  });
});

// ---------------------------------------------------------------------------
// claudeHookMatcherSchema (sub-schema unit tests)
// ---------------------------------------------------------------------------

describe('claudeHookMatcherSchema', () => {
  it('accepts a matcher with only required hooks array', () => {
    expect(claudeHookMatcherSchema.safeParse({ hooks: [] }).success).toBe(true);
  });

  it('accepts a matcher with all fields', () => {
    expect(
      claudeHookMatcherSchema.safeParse({
        matcher: 'Write',
        description: 'desc',
        hooks: [{ type: 'command', command: 'echo x' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a matcher missing the hooks array', () => {
    expectInvalid(claudeHookMatcherSchema, { matcher: 'Write' });
  });
});

// ---------------------------------------------------------------------------
// claudeAgentFrontmatterSchema
// ---------------------------------------------------------------------------

describe('claudeAgentFrontmatterSchema', () => {
  const experimenterFrontmatter = {
    name: 'experimenter',
    description: 'Orchestrates blind skill evaluation across model tiers',
    tools: ['Agent', 'Read', 'Write', 'Glob', 'Grep', 'Bash'],
    model: 'opus',
  };

  const testSubjectFrontmatter = {
    name: 'test-subject',
    description:
      'Blind agent that executes a skill and produces output without knowledge of expected outcomes',
    model: 'sonnet',
    tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep', 'Edit'],
  };

  it('accepts experimenter frontmatter from skill-evaluator', () => {
    expect(claudeAgentFrontmatterSchema.safeParse(experimenterFrontmatter).success).toBe(true);
  });

  it('accepts test-subject frontmatter from skill-evaluator', () => {
    expect(claudeAgentFrontmatterSchema.safeParse(testSubjectFrontmatter).success).toBe(true);
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = claudeAgentFrontmatterSchema.safeParse({
      ...experimenterFrontmatter,
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an arbitrary unknown field (passthrough / loose)', () => {
    // Frontmatter is .passthrough() — extra keys pass through
    const result = claudeAgentFrontmatterSchema.safeParse({
      ...experimenterFrontmatter,
      platformSpecificKey: 'some-value',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).platformSpecificKey).toBe('some-value');
    }
  });

  it('accepts a tool name that is not a known Claude tool (no enum enforcement here)', () => {
    // Tool-name validation is Stage 3's responsibility
    const result = claudeAgentFrontmatterSchema.safeParse({
      name: 'my-agent',
      description: 'test',
      tools: ['NotARealClaudeTool'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an agent with only name and description', () => {
    expect(
      claudeAgentFrontmatterSchema.safeParse({ name: 'simple', description: 'a simple agent' })
        .success,
    ).toBe(true);
  });

  // --- negative tests ---

  it('rejects frontmatter missing name', () => {
    expectInvalid(claudeAgentFrontmatterSchema, { description: 'no name here' });
  });

  it('rejects frontmatter missing description', () => {
    expectInvalid(claudeAgentFrontmatterSchema, { name: 'my-agent' });
  });

  it('rejects tools that is not an array (wrong type)', () => {
    expectInvalid(claudeAgentFrontmatterSchema, {
      name: 'my-agent',
      description: 'test',
      tools: 'Read,Write',
    });
  });
});
