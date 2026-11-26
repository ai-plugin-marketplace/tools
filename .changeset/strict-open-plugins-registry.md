---
'@ai-plugin-marketplace/core': patch
---

Validate hand-authored Open Plugins registries for Open Plugins-only and multi-target plugins. Require unique entry names, resolve sources from `metadata.pluginRoot`, and reject plugin directories that resolve outside the repo. Resolve direct plugin paths under nested `pluginsRoot` values and report forbidden registrations in malformed Open Plugins registries.
