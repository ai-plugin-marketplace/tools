import { defineConfig } from 'vitest/config';

/**
 * On constrained CI runners (GitHub Actions = 2 cores), this suite drives a lot of synchronous
 * jiti transpilation — every `aipm.config.ts` / `aipm.repo.ts` / `aipm.workspace.ts` load compiles
 * TypeScript on the fly, and the build/validate tests do many such loads. With the default fork
 * pool fanning out across all cores, the worker processes starved the main-process reporter, which
 * intermittently failed the whole run with `[vitest-worker]: Timeout calling "onTaskUpdate"` — an
 * RPC heartbeat timeout, not a real test failure (every test passed). It even recurred on PRs that
 * changed zero code.
 *
 * Capping the pool to a single fork on CI leaves the main process a full core to service the
 * reporter RPC, eliminating the flake. The suite is small (~600 tests, low single-digit seconds of
 * actual test time), so serializing on CI costs little. Local runs keep full parallelism.
 */
const isCi = Boolean(process.env['CI']);

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // jiti compiles aipm.config.ts on first run; allow 30 s on cold CI runners.
    testTimeout: 30_000,
    pool: 'forks',
    // `singleFork` runs every test file in one reused fork (serial) — the idiomatic vitest way to
    // say "no fork fan-out," leaving the main process a free core to service the reporter RPC.
    ...(isCi ? { poolOptions: { forks: { singleFork: true } } } : {}),
  },
});
