import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // jiti compiles aipm.config.ts on first run; allow 30 s on cold CI runners.
    testTimeout: 30_000,
  },
});
