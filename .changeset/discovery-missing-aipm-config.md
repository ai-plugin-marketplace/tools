---
'@ai-plugin-marketplace/core': patch
'@ai-plugin-marketplace/cli': patch
---

Fix `aipm validate`/`aipm build` silently ignoring a plugin-shaped `plugins/*` directory (has a
target manifest and/or a skill) that is missing `aipm.config.ts`. Discovery previously filtered
repo-root candidates on config presence alone, so such a directory never reached the plugin list —
`validate` reported green and `build` reported "Built 0 plugin(s)" with exit 0 even though the
plugin was broken and unbuildable. Discovery now also includes plugin-shaped-but-configless
directories; downstream handling is unchanged (hard `envelope-invalid` from `validate`, a thrown
error naming the missing `aipm.config.ts` from `build`) — the same diagnostic a single-plugin
target missing its config already produced. A directory with neither a config nor any plugin-shape
marker is still correctly excluded from discovery.
