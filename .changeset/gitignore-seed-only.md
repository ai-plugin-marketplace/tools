---
'@ai-plugin-marketplace/core': minor
---

`aipm init` now seeds a comprehensive `.gitignore` and stops refresh-managing it.

- **Safety fix:** a fresh `aipm init` previously wrote only a 4-line `.gitignore`, so a brand-new
  scaffold could easily commit secrets. The seeded `.gitignore` now ignores `.env*`, `*.log`,
  `coverage`, common caches, and `scratch/` (while retaining `node_modules/`, `*.tsbuildinfo`,
  `*.local.*`, and `.DS_Store`). Build output (`dist/`) is deliberately still tracked.
- **No more perpetual refresh conflict:** `.gitignore` is now **seed-only** — written by `init` and
  owned by the user thereafter. It has been removed from the `aipm init --refresh` managed set
  (`.aipm/scaffold.json` now tracks only `.github/workflows/ci.yml`), so user additions to
  `.gitignore` are never clobbered or perpetually flagged as conflicts.
