import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config delegates to per-package projects so that each package
 * owns a self-contained `test` script (`vitest run`). Running `vitest run` from
 * the workspace root aggregates every project; running it from a package dir
 * picks up only that package's own config.
 */
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
});
