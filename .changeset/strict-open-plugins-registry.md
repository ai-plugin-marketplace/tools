---
'@ai-plugin-marketplace/core': patch
---

Validate hand-authored Open Plugins registries for Open Plugins-only and multi-target plugins. Require unique entry names and resolve each discovered plugin's source through the filesystem from `metadata.pluginRoot`. Accept in-repo aliases of the plugin directory and reject sources that escape the repo. Resolve direct plugin paths under nested `pluginsRoot` values without loading configs above the owning marketplace or Git checkout, and report readable forbidden registrations even when another entry is malformed.

Known limitation. Repo-wide hand-authored registration checks can miss sources for entries that plugin discovery skips, such as missing or symlinked plugin directories.
