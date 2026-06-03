---
'@ai-plugin-marketplace/core': patch
---

Stop transpiling the whole package on every config load.

When jiti loads an `aipm.config.ts` / `aipm.repo.ts` / `aipm.workspace.ts`, the loader aliased the `@ai-plugin-marketplace/core` import to the package **index**, which re-exports the entire source graph (`operations` → `build`/`validate` → all six targets + `yaml`). So every config load re-transpiled the whole package — hundreds of times across a run — which on slow CI blocked the test worker long enough to trip vitest's `onTaskUpdate` RPC timeout intermittently (a flake that never reproduced locally because production loads the precompiled `dist/`, not source).

The loader now aliases the specifier to the minimal **`config`** module (the `define*` functions; deps are just `zod` + `types`), and enables jiti's content-keyed on-disk transpile cache (`fsCache: true`) while keeping the in-memory module cache off (so in-process rewrites are still re-evaluated — covered by a new regression test). Together these cut the build/validate suite's test time by roughly an order of magnitude (~35s → ~3s locally). Also reverts an earlier single-fork CI workaround that addressed the wrong layer.
