/**
 * Tests for Kiro target Zod schemas.
 *
 * Validates `kiroPowerMdFrontmatterSchema`, `kiroMcpConfigSchema`, and
 * `kiroAgentConfigSchema` against realistic inputs derived from the template
 * repository's real plugin examples.
 *
 * @see /plugins/skill-evaluator/POWER.md        (real POWER.md frontmatter example)
 * @see /plugins/skill-evaluator/mcp.json        (real Kiro mcp.json example)
 * @see src/build-standalone.ts#buildKiroAgentJson (agent config shape reference)
 * @see docs/specs/architecture.md §9.4, §12.2   (schemaVersion reserved field)
 */

import { describe, expect, it } from 'vitest';
import {
  KIRO_TOOL_NAMES,
  kiroAgentConfigSchema,
  kiroMcpConfigSchema,
  kiroPowerMdFrontmatterSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// kiroPowerMdFrontmatterSchema
// ---------------------------------------------------------------------------

describe('kiroPowerMdFrontmatterSchema', () => {
  it('accepts realistic POWER.md frontmatter from skill-evaluator', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'skill-evaluator',
      description:
        'Evaluate AI skills across model tiers with blind testing and refinement recommendations',
      version: '0.0.1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('skill-evaluator');
      expect(result.data.version).toBe('0.0.1');
    }
  });

  it('accepts schemaVersion: "0.1.0" per §9.4 reserved field', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'my-plugin',
      description: 'A plugin',
      version: '1.0.0',
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('0.1.0');
    }
  });

  it('tolerates unknown top-level frontmatter fields (loose schema)', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'my-plugin',
      description: 'A plugin',
      version: '1.0.0',
      tags: ['ai', 'tools'],
      homepage: 'https://example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects frontmatter missing the required name field', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      description: 'No name here',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter missing the required description field', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter missing the required version field', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'my-plugin',
      description: 'A plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter where name is not a string', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 42,
      description: 'A plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter where version is not a string', () => {
    const result = kiroPowerMdFrontmatterSchema.safeParse({
      name: 'my-plugin',
      description: 'A plugin',
      version: 1,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kiroMcpConfigSchema
// ---------------------------------------------------------------------------

describe('kiroMcpConfigSchema', () => {
  it('accepts the skill-evaluator mcp.json (empty mcpServers)', () => {
    const result = kiroMcpConfigSchema.safeParse({ mcpServers: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toEqual({});
    }
  });

  it('accepts a fully-populated mcp.json with server entries', () => {
    const result = kiroMcpConfigSchema.safeParse({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['server.js', '--port', '3000'],
          env: { NODE_ENV: 'production' },
        },
        'minimal-server': {
          command: 'python3',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.mcpServers)).toHaveLength(2);
    }
  });

  it('accepts schemaVersion: "0.1.0" per §9.4 reserved field', () => {
    const result = kiroMcpConfigSchema.safeParse({
      mcpServers: {},
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('0.1.0');
    }
  });

  it('rejects a config missing the required mcpServers field', () => {
    const result = kiroMcpConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a server entry where command is not a string', () => {
    const result = kiroMcpConfigSchema.safeParse({
      mcpServers: {
        'bad-server': { command: 42 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level fields (strict schema)', () => {
    const result = kiroMcpConfigSchema.safeParse({
      mcpServers: {},
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields in a server entry (strict server schema)', () => {
    const result = kiroMcpConfigSchema.safeParse({
      mcpServers: {
        'bad-server': {
          command: 'node',
          unknownServerField: 'not allowed',
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kiroAgentConfigSchema
// ---------------------------------------------------------------------------

/** A minimal valid Kiro agent config matching `buildKiroAgentJson` output shape. */
const VALID_AGENT_CONFIG = {
  name: 'experimenter',
  description: 'Evaluates AI skills and produces a refinement report',
  prompt: 'You are an expert evaluator...',
  mcpServers: {},
  tools: ['read', 'write', 'shell'],
  toolAliases: {},
  allowedTools: [],
  resources: [],
  hooks: {},
  toolsSettings: {},
  includeMcpJson: true,
  model: null,
} as const;

describe('kiroAgentConfigSchema', () => {
  it('accepts a realistic agent config matching buildKiroAgentJson output', () => {
    const result = kiroAgentConfigSchema.safeParse(VALID_AGENT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('experimenter');
      expect(result.data.includeMcpJson).toBe(true);
      expect(result.data.model).toBeNull();
    }
  });

  it('accepts a config with model set to a string', () => {
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      model: 'claude-sonnet-4-6',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('claude-sonnet-4-6');
    }
  });

  it('accepts schemaVersion: "0.1.0" per §9.4 reserved field', () => {
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      schemaVersion: '0.1.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('0.1.0');
    }
  });

  it('does not enforce Kiro tool-name enum on tools (Stage 3 responsibility)', () => {
    // Tool-name validation belongs to Stage 3's transform layer, not this schema.
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      tools: ['some_future_tool', 'another_tool'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing the required name field', () => {
    const { name: _name, ...withoutName } = VALID_AGENT_CONFIG;
    const result = kiroAgentConfigSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it('rejects a config missing the required description field', () => {
    const { description: _description, ...withoutDescription } = VALID_AGENT_CONFIG;
    const result = kiroAgentConfigSchema.safeParse(withoutDescription);
    expect(result.success).toBe(false);
  });

  it('rejects a config where includeMcpJson is not a boolean', () => {
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      includeMcpJson: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level fields (strict schema)', () => {
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      unexpectedField: 'generator bug',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a config where model is not a string or null', () => {
    const result = kiroAgentConfigSchema.safeParse({
      ...VALID_AGENT_CONFIG,
      model: 42,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KIRO_TOOL_NAMES regression guard
// ---------------------------------------------------------------------------

describe('KIRO_TOOL_NAMES', () => {
  it('contains exactly the six canonical Kiro CLI tool names', () => {
    // Derived from the CLAUDE_TO_KIRO_TOOLS mapping in build-standalone.ts.
    // This test is a regression guard: if the tool-name table changes, this
    // test will fail and force a deliberate review.
    expect(KIRO_TOOL_NAMES).toHaveLength(6);
    expect(KIRO_TOOL_NAMES).toContain('read');
    expect(KIRO_TOOL_NAMES).toContain('write');
    expect(KIRO_TOOL_NAMES).toContain('grep');
    expect(KIRO_TOOL_NAMES).toContain('glob');
    expect(KIRO_TOOL_NAMES).toContain('shell');
    expect(KIRO_TOOL_NAMES).toContain('delegate');
  });
});
