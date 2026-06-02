/**
 * Tests for the OpenAI Codex CLI target Zod schemas.
 *
 * Field semantics derived from the Codex plugin-build documentation. Positive fixtures mirror the
 * shared skill-evaluator plugin shape used by the other in-place targets.
 *
 * @see https://developers.openai.com/codex/plugins/build
 */

import { describe, expect, it } from 'vitest';
import { codexMcpConfigSchema, codexPluginManifestSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// codexPluginManifestSchema
// ---------------------------------------------------------------------------

describe('codexPluginManifestSchema', () => {
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
  };

  it('accepts a realistic plugin.json fixture', () => {
    expect(() => codexPluginManifestSchema.parse(validManifest)).not.toThrow();
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = codexPluginManifestSchema.parse({
      ...validManifest,
      schemaVersion: '0.1.0',
    });
    expect(result.schemaVersion).toBe('0.1.0');
  });

  it('accepts a minimal manifest (name only)', () => {
    expect(() => codexPluginManifestSchema.parse({ name: 'my-plugin' })).not.toThrow();
  });

  it('accepts a plain string skills path (Codex tolerance)', () => {
    expect(() =>
      codexPluginManifestSchema.parse({ name: 'my-plugin', skills: './skills/' }),
    ).not.toThrow();
  });

  it('accepts a string mcpServers path (Codex points at a .mcp.json file)', () => {
    expect(() =>
      codexPluginManifestSchema.parse({ name: 'my-plugin', mcpServers: './.mcp.json' }),
    ).not.toThrow();
  });

  it('accepts an inline mcpServers record', () => {
    expect(() =>
      codexPluginManifestSchema.parse({
        name: 'my-plugin',
        mcpServers: { 'my-server': { command: 'node' } },
      }),
    ).not.toThrow();
  });

  it('accepts an optional apps path', () => {
    expect(() =>
      codexPluginManifestSchema.parse({ name: 'my-plugin', apps: './apps/' }),
    ).not.toThrow();
  });

  it('accepts an interface object with arbitrary UI metadata (loose)', () => {
    const result = codexPluginManifestSchema.parse({
      name: 'my-plugin',
      interface: {
        displayName: 'My Plugin',
        category: 'Productivity',
        capabilities: ['chat'],
        brandColor: '#112233',
        unknownFutureField: true,
      },
    });
    expect(result.interface).toMatchObject({ displayName: 'My Plugin' });
  });

  it('accepts an inline hooks object', () => {
    expect(() =>
      codexPluginManifestSchema.parse({
        name: 'my-plugin',
        hooks: { PostToolUse: [] },
      }),
    ).not.toThrow();
  });

  // Negative tests

  it('rejects a missing required name field', () => {
    const result = codexPluginManifestSchema.safeParse({ version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that does not match the pattern', () => {
    const result = codexPluginManifestSchema.safeParse({ name: 'My Plugin' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that starts with a digit', () => {
    const result = codexPluginManifestSchema.safeParse({ name: '1plugin' });
    expect(result.success).toBe(false);
  });

  it('rejects a name that exceeds 64 characters', () => {
    const result = codexPluginManifestSchema.safeParse({ name: 'a'.repeat(65) });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    const result = codexPluginManifestSchema.safeParse({
      name: 'my-plugin',
      unknownField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object author field', () => {
    const result = codexPluginManifestSchema.safeParse({
      name: 'my-plugin',
      author: 'just a string',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an apps path without a "./" prefix', () => {
    const result = codexPluginManifestSchema.safeParse({ name: 'my-plugin', apps: 'apps/' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object interface field', () => {
    const result = codexPluginManifestSchema.safeParse({
      name: 'my-plugin',
      interface: 'not an object',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// codexMcpConfigSchema
// ---------------------------------------------------------------------------

describe('codexMcpConfigSchema', () => {
  it('accepts a minimal .mcp.json with empty mcpServers', () => {
    expect(() => codexMcpConfigSchema.parse({ mcpServers: {} })).not.toThrow();
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
    expect(() => codexMcpConfigSchema.parse(fixture)).not.toThrow();
  });

  it('accepts schemaVersion: "0.1.0"', () => {
    const result = codexMcpConfigSchema.parse({
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
    expect(() => codexMcpConfigSchema.parse(fixture)).not.toThrow();
  });

  // Negative tests

  it('rejects a missing mcpServers field', () => {
    const result = codexMcpConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a server entry with a missing command field', () => {
    const result = codexMcpConfigSchema.safeParse({
      mcpServers: { 'bad-server': { args: [] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    const result = codexMcpConfigSchema.safeParse({
      mcpServers: {},
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });
});
