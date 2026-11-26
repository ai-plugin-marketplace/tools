---
'@ai-plugin-marketplace/core': patch
---

Protect plugin source directories from overlapping bundle destinations. Refuse conflicting repo-root output before writing, and emit byte-identical shared files only once.
