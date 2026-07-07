/**
 * Tests for the Open Plugins target Zod schemas.
 *
 * Assertions are derived directly from the Open Plugins v1.0.0 prose specification (no official
 * JSON Schema is published — see the schema module doc). The `name` grammar and component-path
 * rules under test are the spec's normative MUSTs.
 *
 * @see https://open-plugins.com/plugin-builders/specification.md
 * @see https://open-plugins.com/plugin-builders/marketplace.md
 */

import { describe, expect, it } from 'vitest';
import { openPluginsManifestSchema, openPluginsMarketplaceSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// openPluginsManifestSchema — name grammar (spec §2.1)
// ---------------------------------------------------------------------------

describe('openPluginsManifestSchema — name grammar', () => {
  const parseName = (name: string) => openPluginsManifestSchema.safeParse({ name });

  it('accepts a digit-start name (spec permits a digit start): "0abc"', () => {
    expect(parseName('0abc').success).toBe(true);
  });

  it('accepts an interior period: "a.b"', () => {
    expect(parseName('a.b').success).toBe(true);
  });

  it('accepts a single-character name: "a"', () => {
    expect(parseName('a').success).toBe(true);
  });

  it('accepts the maximum length (64 chars)', () => {
    expect(parseName('a'.repeat(64)).success).toBe(true);
  });

  // Negative cases — each is an Open Plugins name-grammar MUST.

  it('rejects consecutive periods: "a..b"', () => {
    expect(parseName('a..b').success).toBe(false);
  });

  it('rejects consecutive hyphens: "a--b"', () => {
    expect(parseName('a--b').success).toBe(false);
  });

  it('rejects a name exceeding 64 characters (65 chars)', () => {
    expect(parseName('a'.repeat(65)).success).toBe(false);
  });

  it('rejects uppercase characters: "MyPlugin"', () => {
    expect(parseName('MyPlugin').success).toBe(false);
  });

  it('rejects a trailing hyphen: "abc-"', () => {
    expect(parseName('abc-').success).toBe(false);
  });

  it('rejects a trailing period: "abc."', () => {
    expect(parseName('abc.').success).toBe(false);
  });

  it('rejects a leading hyphen: "-abc"', () => {
    expect(parseName('-abc').success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(parseName('').success).toBe(false);
  });

  it('rejects a missing required name field', () => {
    expect(openPluginsManifestSchema.safeParse({ version: '1.0.0' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openPluginsManifestSchema — component-path fields (spec §2.1)
// ---------------------------------------------------------------------------

describe('openPluginsManifestSchema — component paths', () => {
  const withCommands = (commands: unknown) =>
    openPluginsManifestSchema.safeParse({ name: 'my-plugin', commands });

  it('accepts a "./"-relative string path: "./commands"', () => {
    expect(withCommands('./commands').success).toBe(true);
  });

  it('accepts an array of "./"-relative paths', () => {
    expect(withCommands(['./commands/a.md', './commands/b.md']).success).toBe(true);
  });

  it('accepts the { paths, exclusive } object form', () => {
    expect(withCommands({ paths: ['./commands'], exclusive: true }).success).toBe(true);
  });

  it('accepts the { paths } object form without exclusive', () => {
    expect(withCommands({ paths: ['./commands'] }).success).toBe(true);
  });

  // Negative cases — every path MUST be "./"-relative with no parent traversal (§2.1).

  it('rejects a parent-traversal path: "../x"', () => {
    expect(withCommands('../x').success).toBe(false);
  });

  it('rejects a bare (non-"./"-prefixed) path: "x/y"', () => {
    expect(withCommands('x/y').success).toBe(false);
  });

  it('rejects a ".." segment inside an otherwise "./"-relative path: "./a/../b"', () => {
    expect(withCommands('./a/../b').success).toBe(false);
  });

  it('rejects a bare path inside the array form', () => {
    expect(withCommands(['./ok', 'not-ok']).success).toBe(false);
  });

  it('rejects a "../" path inside the { paths } object form', () => {
    expect(withCommands({ paths: ['../escape'] }).success).toBe(false);
  });

  it('rejects an unknown key in the { paths } object form (confirms .strict())', () => {
    expect(withCommands({ paths: ['./ok'], bogus: true }).success).toBe(false);
  });

  it('accepts every component field name (commands/agents/skills/rules/hooks/mcpServers/lspServers/outputStyles)', () => {
    const manifest = {
      name: 'my-plugin',
      commands: './commands',
      agents: ['./agents/a.md'],
      skills: './skills',
      rules: ['./rules/a.mdc'],
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
      lspServers: './.lsp.json',
      outputStyles: { paths: ['./output-styles'] },
    };
    expect(openPluginsManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openPluginsManifestSchema — optional fields & strictness
// ---------------------------------------------------------------------------

describe('openPluginsManifestSchema — optional fields', () => {
  it('accepts a full manifest with all optional metadata', () => {
    const manifest = {
      schemaVersion: '0.1.0',
      name: 'my-plugin',
      version: '1.2.3',
      description: 'Does a thing',
      author: { name: 'Someone', email: 's@example.com', url: 'https://example.com' },
      homepage: 'https://example.com',
      repository: 'https://github.com/x/y',
      license: 'MIT',
      logo: './logo.png',
      keywords: ['a', 'b'],
    };
    expect(openPluginsManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts schemaVersion without validating it', () => {
    const result = openPluginsManifestSchema.parse({ name: 'my-plugin', schemaVersion: '99.9.9' });
    expect(result.schemaVersion).toBe('99.9.9');
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    expect(openPluginsManifestSchema.safeParse({ name: 'my-plugin', bogus: 1 }).success).toBe(
      false,
    );
  });

  it('rejects a non-object author field', () => {
    expect(openPluginsManifestSchema.safeParse({ name: 'my-plugin', author: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects a non-semver version', () => {
    expect(openPluginsManifestSchema.safeParse({ name: 'my-plugin', version: 'v1' }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// openPluginsMarketplaceSchema (spec §2.4)
// ---------------------------------------------------------------------------

describe('openPluginsMarketplaceSchema', () => {
  const validEntry = { name: 'alpha', source: './plugins/alpha' };

  it('accepts a minimal marketplace with name + one plugin entry', () => {
    const result = openPluginsMarketplaceSchema.safeParse({
      name: 'my-market',
      plugins: [validEntry],
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional owner and metadata.pluginRoot', () => {
    const result = openPluginsMarketplaceSchema.safeParse({
      name: 'my-market',
      owner: { name: 'Owner', email: 'o@example.com', url: 'https://example.com' },
      metadata: { pluginRoot: './plugins' },
      plugins: [validEntry],
    });
    expect(result.success).toBe(true);
  });

  it('accepts entry-level metadata overrides (description/version/author/license/keywords)', () => {
    const result = openPluginsMarketplaceSchema.safeParse({
      name: 'my-market',
      plugins: [
        {
          ...validEntry,
          description: 'A plugin',
          version: '1.0.0',
          author: { name: 'X' },
          license: 'MIT',
          keywords: ['k'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // Negative cases

  it('rejects an empty plugins array (spec requires >= 1 entry, §2.4)', () => {
    expect(openPluginsMarketplaceSchema.safeParse({ name: 'my-market', plugins: [] }).success).toBe(
      false,
    );
  });

  it('rejects a missing plugins field', () => {
    expect(openPluginsMarketplaceSchema.safeParse({ name: 'my-market' }).success).toBe(false);
  });

  it('rejects a missing name field', () => {
    expect(openPluginsMarketplaceSchema.safeParse({ plugins: [validEntry] }).success).toBe(false);
  });

  it('rejects an entry with a non-"./"-relative source', () => {
    expect(
      openPluginsMarketplaceSchema.safeParse({
        name: 'my-market',
        plugins: [{ name: 'alpha', source: 'plugins/alpha' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an entry with a ".." source', () => {
    expect(
      openPluginsMarketplaceSchema.safeParse({
        name: 'my-market',
        plugins: [{ name: 'alpha', source: './../alpha' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level field (confirms .strict())', () => {
    expect(
      openPluginsMarketplaceSchema.safeParse({
        name: 'my-market',
        plugins: [validEntry],
        bogus: true,
      }).success,
    ).toBe(false);
  });
});
