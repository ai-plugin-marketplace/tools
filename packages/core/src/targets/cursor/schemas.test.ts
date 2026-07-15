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
  cursorHooksFileSchema,
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

  it('accepts mcpServers as a ./ path string', () => {
    expect(() =>
      cursorPluginManifestSchema.parse({ name: 'my-plugin', mcpServers: './.mcp.json' }),
    ).not.toThrow();
  });

  it('accepts mcpServers as an inline record', () => {
    expect(() =>
      cursorPluginManifestSchema.parse({
        name: 'my-plugin',
        mcpServers: { myserver: { command: 'node' } },
      }),
    ).not.toThrow();
  });

  // Negative tests

  it('rejects an mcpServers path that does not start with ./', () => {
    const result = cursorPluginManifestSchema.safeParse({
      name: 'my-plugin',
      mcpServers: '.mcp.json',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an mcpServers path that is not a .json file', () => {
    const result = cursorPluginManifestSchema.safeParse({
      name: 'my-plugin',
      mcpServers: './mcp.txt',
    });
    expect(result.success).toBe(false);
  });

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

// ---------------------------------------------------------------------------
// cursorHooksFileSchema (spec docs/specs/cursor-hooks-target.md §3.4)
//
// Strict schema for the toolkit-generated hooks/cursor.json: { version: 1, hooks: … } with the
// four emitted camelCase events and flat command entries.
// @see https://cursor.com/docs/hooks.md — Cursor hook format
// ---------------------------------------------------------------------------

describe('cursorHooksFileSchema — positive', () => {
  it('parses a valid Cursor hooks document', () => {
    const doc = {
      version: 1,
      hooks: {
        preToolUse: [{ command: './guard.sh', type: 'command', matcher: 'Shell' }],
        beforeSubmitPrompt: [{ command: './prompt.sh' }],
      },
    };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts all four emitted event keys', () => {
    const doc = {
      version: 1,
      hooks: {
        preToolUse: [{ command: './a.sh' }],
        postToolUse: [{ command: './b.sh' }],
        stop: [{ command: './c.sh' }],
        beforeSubmitPrompt: [{ command: './d.sh' }],
      },
    };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts an optional schemaVersion (accepted-not-validated)', () => {
    const doc = { schemaVersion: '0.1.0', version: 1, hooks: { stop: [{ command: './c.sh' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts an entry with no matcher and no type', () => {
    const doc = { version: 1, hooks: { stop: [{ command: './c.sh' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts a shimmed controller entry: a shim command with failClosed (§3.1)', () => {
    // The gating path emits `{ command: "node ./hooks/cursor-shim.mjs …", matcher, failClosed }`.
    const doc = {
      version: 1,
      hooks: {
        preToolUse: [
          {
            command: 'node ./hooks/cursor-shim.mjs preToolUse -- ./gate.sh',
            matcher: 'Shell',
            failClosed: true,
          },
        ],
        beforeSubmitPrompt: [
          {
            command: 'node ./hooks/cursor-shim.mjs beforeSubmitPrompt -- ./prompt.sh',
            failClosed: true,
          },
        ],
      },
    };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(true);
  });

  it('rejects a non-boolean failClosed', () => {
    const doc = { version: 1, hooks: { preToolUse: [{ command: './c.sh', failClosed: 'yes' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });
});

describe('cursorHooksFileSchema — negative', () => {
  it('rejects a missing version', () => {
    expect(
      cursorHooksFileSchema.safeParse({ hooks: { stop: [{ command: './c.sh' }] } }).success,
    ).toBe(false);
  });

  it('rejects a wrong version (2 instead of literal 1)', () => {
    const doc = { version: 2, hooks: { stop: [{ command: './c.sh' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an unknown event key', () => {
    const doc = { version: 1, hooks: { beforeShellExecution: [{ command: './c.sh' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an entry missing command', () => {
    const doc = { version: 1, hooks: { stop: [{ type: 'command', matcher: 'Shell' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an entry with an unknown extra field (strict)', () => {
    const doc = { version: 1, hooks: { stop: [{ command: './c.sh', timeout: 5 }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an unknown top-level field (strict)', () => {
    const doc = { version: 1, hooks: { stop: [{ command: './c.sh' }] }, extra: true };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a wrong type literal on an entry', () => {
    const doc = { version: 1, hooks: { stop: [{ command: './c.sh', type: 'shell' }] } };
    expect(cursorHooksFileSchema.safeParse(doc).success).toBe(false);
  });
});
