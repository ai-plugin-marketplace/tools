---
'@ai-plugin-marketplace/core': patch
---

Cache config transpilation on disk (jiti `fsCache`) to cut repeated compile cost.

Each `aipm.config.ts` / `aipm.repo.ts` / `aipm.workspace.ts` load transpiles TypeScript on the fly. The loader previously disabled all jiti caching; it now enables the content-keyed on-disk transpile cache (`fsCache: true`) while keeping the in-memory module cache off, so a config rewritten in-process is still re-evaluated (correctness preserved) but identical sources skip re-transpiling. This roughly halves the build/validate suite's CPU, fixing an intermittent CI failure where the jiti-heavy work starved a vitest worker's RPC heartbeat (`Timeout calling "onTaskUpdate"`). Also reverts the earlier single-fork CI workaround, which addressed the wrong layer.
