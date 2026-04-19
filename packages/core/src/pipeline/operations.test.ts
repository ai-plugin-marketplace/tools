/**
 * Smoke tests for the core skeleton. Stages 2–8 of the bootstrap plan layer in real behavior
 * tests; these exist to prove the test runner is wired up and the public contract surface
 * compiles and returns expected shapes.
 */

import { describe, expect, it } from 'vitest';
import { defineConfig, listTargets, migrate } from '../index.js';

describe('listTargets()', () => {
  it('returns the canonical set of known targets', () => {
    expect(listTargets()).toEqual(['claude', 'cursor', 'gemini', 'kiro', 'vercel']);
  });
});

describe('migrate()', () => {
  it('is a no-op in v0.1.0 and returns the no-migrations-needed discriminant', async () => {
    const result = await migrate(process.cwd());
    expect(result).toEqual({
      status: 'no-migrations-needed',
      migrationsApplied: 0,
      filesChanged: [],
    });
  });
});

describe('defineConfig()', () => {
  it('accepts a valid config and returns it (branded at the type level)', () => {
    const cfg = defineConfig({
      version: '0.1.0',
      targets: ['claude', 'cursor'],
    });
    expect(cfg.version).toBe('0.1.0');
    expect(cfg.targets).toEqual(['claude', 'cursor']);
  });

  it('rejects a non-semver version string', () => {
    expect(() =>
      defineConfig({
        version: 'v1',
        targets: ['claude'],
      }),
    ).toThrow();
  });

  it('rejects an unknown target ID', () => {
    expect(() =>
      defineConfig({
        version: '0.1.0',
        // @ts-expect-error — intentionally invalid target for runtime coverage
        targets: ['cluade'],
      }),
    ).toThrow();
  });

  it('rejects an empty targets array', () => {
    expect(() =>
      defineConfig({
        version: '0.1.0',
        targets: [],
      }),
    ).toThrow();
  });

  it('rejects duplicate targets', () => {
    expect(() =>
      defineConfig({
        version: '0.1.0',
        targets: ['claude', 'claude'],
      }),
    ).toThrow();
  });

  it('rejects unknown keys (.strict() passthrough)', () => {
    expect(() =>
      defineConfig({
        version: '0.1.0',
        targets: ['claude'],
        // @ts-expect-error — extra key should fail
        extra: 'nope',
      }),
    ).toThrow();
  });
});
