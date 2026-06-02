---
'@ai-plugin-marketplace/core': minor
---

Add optional repo-level configuration (`aipm.repo.ts` / `defineRepoConfig`) for relocating the plugins and dist roots.

This lets a marketplace live inside a repo whose primary purpose is shipping software: when the host repo already owns a top-level `plugins/` or `dist/`, declare a `pluginsRoot` / `distDir` in `aipm.repo.ts` and the toolkit discovers, builds, validates, and scaffolds against the relocated roots. The file is optional and fully backward compatible — absent it, the historical `plugins/` + `dist/` topology is used unchanged.

- New public exports: `defineRepoConfig`, `AipmRepoConfig`, `AipmRepoConfigInput`.
- Marketplace `source` registration now expects the plugin's path relative to the repo root, so a relocated `pluginsRoot` validates correctly.
- A present-but-invalid `aipm.repo.ts` (unknown keys, absolute paths, `..` escapes) surfaces as a new `repo-config-invalid` validation finding rather than an unstructured error.
