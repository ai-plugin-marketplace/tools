---
'@ai-plugin-marketplace/core': patch
---

Check bundle trees and generated files together before writing. Protect plugin sources and the symlink chains of bundle inputs during cleanup, reserve sibling bundle destinations during selective builds, and report byte-identical root files from multiple targets as shared. Stage hook bytes before generating dependent bundles and resolve known paths through search-only ancestors.

Known limitations:

- Separate hard links to the same inode can still receive competing writes.
- A leaf-symlink ownership handoff can leave the link target untracked in the generated-root manifest.
- Case handling can misclassify an NTFS directory with a policy different from its parent when no known entry is available to probe, including an empty directory.
