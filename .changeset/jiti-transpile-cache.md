---
'@ai-plugin-marketplace/core': patch
---

Cache config transpilation on disk (jiti `fsCache`) to cut repeated compile cost.

Each `aipm.config.ts` / `aipm.repo.ts` / `aipm.workspace.ts` load transpiles TypeScript on the fly. The loader previously disabled all jiti caching; it now enables the content-keyed on-disk transpile cache (`fsCache: true`) while keeping the in-memory module cache off, so a config rewritten in-process is still re-evaluated (correctness preserved) but identical sources skip re-transpiling. This roughly halves the build/validate suite's CPU. It is intended to reduce the load that contributes to an intermittent CI failure (`Timeout calling "onTaskUpdate"`); whether it fully eliminates that flake is still under investigation. Also reverts an earlier single-fork CI workaround.
