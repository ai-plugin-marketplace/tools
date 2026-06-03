---
'@ai-plugin-marketplace/core': minor
---

Add opt-in marketplace-registry generation via `aipm.workspace.ts` (`defineWorkspace`), plus optional shared plugin metadata on `aipm.config.ts`.

When a repo declares an `aipm.workspace.ts` at its root, the toolkit now GENERATES the per-target marketplace registries (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) from the workspace metadata plus the discovered plugins. The generated registries are written by `aipm build`, committed, and freshness-checked (regenerate-and-byte-compare, like `dist/` bundles). This removes the manual chore of hand-editing the registries.

- New public exports: `defineWorkspace`, `AipmWorkspace`, `AipmWorkspaceInput`.
- New optional fields on `aipm.config.ts` (`defineConfig`): `description` and `keywords`. They feed each generated registry entry's `description` and `tags` (Claude/Cursor). Both are optional, so existing configs stay valid.
- The opt-in is fully backward compatible: when no `aipm.workspace.ts` is present, registries remain hand-authored and the existing `marketplace-registration` validation runs unchanged.

Consumer-visible finding-code shift: in repos that opt into generation, registry correctness is now enforced by the `freshness` finding code (a wrong or stale entry is regenerated-and-compared) and the per-plugin `marketplace-registration` check is skipped to avoid double-reporting. Repos without `aipm.workspace.ts` continue to emit `marketplace-registration` as before.
