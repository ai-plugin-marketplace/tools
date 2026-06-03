/**
 * Tests for the `define*` config validators in `config.ts`.
 *
 * `defineConfig`/`defineRepoConfig` are exercised indirectly through `load-config.test.ts`; this
 * file covers `defineWorkspace` (registry-generation opt-in metadata) directly: branding on valid
 * input, `.strict()` rejection of unknown keys, and the required `marketplace.name`. It also pins
 * the new optional `description`/`keywords` fields on `defineConfig` so existing configs without
 * them stay valid.
 *
 * @see docs/specs/manifest-and-registry-codegen.md §"Single sources of truth"
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineConfig, defineWorkspace } from './config.js';

describe('defineConfig — optional registry metadata', () => {
  it('accepts a config without description/keywords (backward compatible)', () => {
    const config = defineConfig({ version: '1.0.0', targets: ['claude'] });
    expect(config.description).toBeUndefined();
    expect(config.keywords).toBeUndefined();
  });

  it('preserves description and keywords when provided', () => {
    const config = defineConfig({
      version: '1.0.0',
      targets: ['claude'],
      description: 'A test plugin',
      keywords: ['alpha', 'beta'],
    });
    expect(config.description).toBe('A test plugin');
    expect(config.keywords).toStrictEqual(['alpha', 'beta']);
  });
});

describe('defineWorkspace — valid input', () => {
  it('brands a minimal workspace (marketplace.name only)', () => {
    const ws = defineWorkspace({ marketplace: { name: 'my-market' } });
    expect(ws.marketplace.name).toBe('my-market');
    expect(ws.marketplace.owner).toBeUndefined();
    expect(ws.marketplace.description).toBeUndefined();
  });

  it('preserves owner (name + optional email) and description', () => {
    const ws = defineWorkspace({
      marketplace: {
        name: 'my-market',
        owner: { name: 'Owner', email: 'owner@example.com' },
        description: 'Universal marketplace',
      },
    });
    expect(ws.marketplace.owner).toStrictEqual({ name: 'Owner', email: 'owner@example.com' });
    expect(ws.marketplace.description).toBe('Universal marketplace');
  });

  it('allows an owner without an email', () => {
    const ws = defineWorkspace({ marketplace: { name: 'm', owner: { name: 'Owner' } } });
    expect(ws.marketplace.owner).toStrictEqual({ name: 'Owner' });
  });
});

describe('defineWorkspace — invalid input', () => {
  it('rejects a missing marketplace.name', () => {
    // @ts-expect-error — name is required; this proves the runtime guard, not just the type.
    expect(() => defineWorkspace({ marketplace: {} })).toThrow(z.ZodError);
  });

  it('rejects an empty marketplace.name', () => {
    expect(() => defineWorkspace({ marketplace: { name: '' } })).toThrow(z.ZodError);
  });

  it('rejects an unknown top-level key (.strict())', () => {
    expect(() =>
      // @ts-expect-error — unknown key rejected by the strict schema.
      defineWorkspace({ marketplace: { name: 'm' }, extra: true }),
    ).toThrow(z.ZodError);
  });

  it('rejects an unknown key inside marketplace (.strict())', () => {
    expect(() =>
      // @ts-expect-error — unknown nested key rejected by the strict schema.
      defineWorkspace({ marketplace: { name: 'm', tagline: 'nope' } }),
    ).toThrow(z.ZodError);
  });

  it('rejects an unknown key inside marketplace.owner (.strict())', () => {
    expect(() =>
      defineWorkspace({
        // @ts-expect-error — unknown owner key rejected by the strict schema.
        marketplace: { name: 'm', owner: { name: 'Owner', role: 'admin' } },
      }),
    ).toThrow(z.ZodError);
  });
});
