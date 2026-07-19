---
'@ai-plugin-marketplace/core': patch
---

Stop copying `README.md`/`LICENSE` into Gemini CLI and Kiro bundle output (`bundleGeminiPlugin`,
`bundleKiroPlugin`, and the repo-root single-artifact-host emission built on them).

The `ai-plugin-marketplace/template` repo moved `README.md`/`LICENSE` from per-plugin source to
the repo root, where they are canonical, author-owned files backing the single emitted Gemini
extension / Kiro power — never a per-plugin generated copy. The bundlers previously still tried to
copy a plugin's own `README.md`/`LICENSE` (when present) into `dist/gemini/<plugin>/`,
`dist/kiro/<plugin>/`, and the repo-root artifact set, which diverged from the template's actual
output and, for repo-root emission, could trip the `root-artifact-collision` guard against the
repo's real root `README.md`/`LICENSE`.
