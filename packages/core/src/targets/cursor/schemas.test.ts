/**
 * Tests for Cursor target Zod schemas.
 *
 * Positive fixtures are derived from the real skill-evaluator plugin in the
 * ai-plugin-marketplace-template repository.
 *
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/schemas/plugin.json
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/plugins/skill-evaluator/.cursor-plugin/plugin.json
 * @see https://github.com/ai-plugin-marketplace/template/blob/main/plugins/skill-evaluator/.mcp.json
 */

import { describe, expect, it } from 'vitest';
import {
  cursorMcpConfigSchema,
  cursorPluginManifestSchema,
  cursorRuleFrontmatterSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// cursorPluginManifestSchema
// ---------------------------------------------------------------------------

describe('cursorPluginManifestSchema', () => {
  const validManifest = {
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

  it('accepts a realistic plugin.json fixture', () => {
    expect(() => cursorPluginManifestSchema.parse(validManifest)).not.toThrow();
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = cursorPluginManifestSchema.parse({
      ...validManifest,
      schemaVersion: '0.1.0',
    });
    expect(result.schemaVersion).toBe('0.1.0');
  });

  it('accepts a minimal manifest (name only)', () => {
    expect(() => cursorPluginManifestSchema.parse({ name: 'my-plugin' })).not.toThrow();
  });

  it('accepts an inline hooks object', () => {
    expect(() =>
      cursorPluginManifestSchema.parse({
        name: 'my-plugin',
        hooks: { PostToolUse: [] },
      }),
    ).not.toThrow();
  });

  it('accepts a commands record object', () => {
    expect(() =>
      cursorPluginManifestSchema.parse({
        name: 'my-plugin',
        commands: { 'my-cmd': { description: 'do something' } },
      }),
    ).not.toThrow();
  });

  // Negative tests

  it('rejects a missing required name field', () => {
    const result = cursorPluginManifestSchema.safeParse({ version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that does not match the pattern', () => {
    const result = cursorPluginManifestSchema.safeParse({ name: 'My Plugin' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that starts with a digit', () => {
    const result = cursorPluginManifestSchema.safeParse({ name: '1plugin' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that exceeds 64 characters', () => {
    const result = cursorPluginManifestSchema.safeParse({ name: 'a'.repeat(65) });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    const result = cursorPluginManifestSchema.safeParse({
      name: 'my-plugin',
      unknownField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object author field', () => {
    const result = cursorPluginManifestSchema.safeParse({
      name: 'my-plugin',
      author: 'just a string',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cursorMcpConfigSchema
// ---------------------------------------------------------------------------

describe('cursorMcpConfigSchema', () => {
  it('accepts a minimal .mcp.json with empty mcpServers', () => {
    expect(() => cursorMcpConfigSchema.parse({ mcpServers: {} })).not.toThrow();
  });

  it('accepts a realistic .mcp.json fixture with a server entry', () => {
    const fixture = {
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['./server.js'],
          env: { DEBUG: 'true' },
        },
      },
    };
    expect(() => cursorMcpConfigSchema.parse(fixture)).not.toThrow();
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = cursorMcpConfigSchema.parse({
      mcpServers: {},
      schemaVersion: '0.1.0',
    });
    expect(result.schemaVersion).toBe('0.1.0');
  });

  it('accepts a server entry without optional args and env', () => {
    const fixture = {
      mcpServers: {
        minimal: { command: 'npx' },
      },
    };
    expect(() => cursorMcpConfigSchema.parse(fixture)).not.toThrow();
  });

  // Negative tests

  it('rejects a missing mcpServers field', () => {
    const result = cursorMcpConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a server entry with a missing command field', () => {
    const result = cursorMcpConfigSchema.safeParse({
      mcpServers: { 'bad-server': { args: [] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    const result = cursorMcpConfigSchema.safeParse({
      mcpServers: {},
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cursorRuleFrontmatterSchema
// ---------------------------------------------------------------------------

describe('cursorRuleFrontmatterSchema', () => {
  it('accepts a realistic .mdc frontmatter fixture from skill-evaluator', () => {
    const fixture = {
      description: 'Evaluation protocol for blind skill testing across model tiers',
      alwaysApply: false,
      globs: ['plugins/skill-evaluator/**'],
    };
    expect(() => cursorRuleFrontmatterSchema.parse(fixture)).not.toThrow();
  });

  it('accepts an empty frontmatter object (all fields optional)', () => {
    expect(() => cursorRuleFrontmatterSchema.parse({})).not.toThrow();
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = cursorRuleFrontmatterSchema.parse({ schemaVersion: '0.1.0' });
    expect(result.schemaVersion).toBe('0.1.0');
  });

  // Negative tests

  it('rejects a non-boolean alwaysApply', () => {
    const result = cursorRuleFrontmatterSchema.safeParse({ alwaysApply: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array globs field', () => {
    const result = cursorRuleFrontmatterSchema.safeParse({ globs: '**/*.ts' });
    expect(result.success).toBe(false);
  });

  it('rejects globs containing a non-string element', () => {
    const result = cursorRuleFrontmatterSchema.safeParse({ globs: [1, 2, 3] });
    expect(result.success).toBe(false);
  });
});
