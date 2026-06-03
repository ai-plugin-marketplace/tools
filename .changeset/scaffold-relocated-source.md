---
'@ai-plugin-marketplace/core': patch
---

Fix `aipm scaffold` and `aipm add-target` to register a repo-relative marketplace `source` that matches a relocated `pluginsRoot`.

Previously the scaffolder hardcoded the registry `source` to `./plugins/<name>`. In an embedded marketplace (an `aipm.repo.ts` relocating `pluginsRoot`, e.g. to `agent-plugins/`), the plugin was written to the relocated root but registered as `./plugins/<name>`, which `aipm validate` then rejected with a `marketplace-registration` finding. The source is now computed as the plugin directory's path relative to the repo root (`./agent-plugins/<name>`), matching the validator, so the scaffold→validate flow is clean in both dedicated and embedded layouts.
