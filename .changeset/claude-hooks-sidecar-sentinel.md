---
'@ai-plugin-marketplace/core': minor
---

Write `hooks/claude.json` without the inline `_generated` sentinel. Claude Code warns on unknown
top-level keys in a plugin's hooks file (`hooks.json: unknown key "_generated" ignored`), so every
session of every plugin that authors hooks showed that warning. The file is now exactly the Claude
transform output, and its sentinel and generator-version stamp live in a
`hooks/claude.json.generated` sidecar, the carrier already used for strict-schema artifacts.

After upgrading, `aipm validate` reports an existing `hooks/claude.json` as stale; run `aipm build`
to rewrite it and add the sidecar. Gemini `hooks/hooks.json` and Cursor `hooks/cursor.json` are
unchanged.
