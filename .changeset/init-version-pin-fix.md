---
'@ai-plugin-marketplace/core': patch
---

Fix `aipm init` pinning a nonexistent `@ai-plugin-marketplace/cli` version. `init` pinned both the
`cli` and `core` dev dependencies to core's own version; because `cli` and `core` ship
independently (e.g. `cli 0.1.1` ships with `core 0.2.0`), this produced a `package.json` requesting
a `cli` version that does not exist on npm, yielding an uninstallable repo. `init` now pins each
dependency to a caret of its own version (the cli entrypoint supplies the cli version).
