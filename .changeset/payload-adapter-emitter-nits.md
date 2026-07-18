---
'@ai-plugin-marketplace/core': patch
---

`hooks/payload-adapter` is no longer emitted for a plugin whose `hooks/claude.yaml` declares zero hook events (`hooks: {}`) — previously the 83-line adapter script (and its sentinel) were emitted even when nothing in the plugin could ever invoke them. The emitted `--schema` output is now pre-sorted at generation time instead of spawning `jq -S .` on every invocation (byte-identical output, no runtime cost), the generated banners in `hooks/payload-adapter` and `hooks/cursor-shim.mjs` now qualify their `docs/specs/*.md` pointers with `@ai-plugin-marketplace/tools` so they resolve for a reader in a consumer repo, and `hooks/payload-adapter`'s temp-file `mktemp` call now uses an explicit template.
