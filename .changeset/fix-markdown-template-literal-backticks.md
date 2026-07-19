---
'@ai-plugin-marketplace/core': patch
'@ai-plugin-marketplace/cli': patch
---

Fix `aipm init`'s `README.md` and `aipm scaffold`'s Kiro `POWER.md` emitting literal
backslash-backtick sequences (`` \` ``, byte pair `5c 60`) instead of real backtick characters
(`0x60`), which rendered the generated Markdown visibly broken.

Root cause: these templates are tagged with `String.raw` (the project convention for multi-line
embedded Markdown, which disables escape-sequence interpretation), but their source still wrote an
escaped backtick (`` \` ``) to embed a literal backtick character — the escape is only interpreted
in an ordinary template literal, so under `String.raw` it stayed as the two literal characters
backslash + backtick. Both templates now interpolate a ``bt = '`'`` constant instead of escaping
the backtick in the template source.

Also fixes Kiro's `POWER.md` "Related Files" bullet, which presented `steering/` as an existing
sibling file even though a freshly-scaffolded plugin has no `steering/` directory (Kiro's scaffold
contributes only `POWER.md`) — it now reads `` `steering/` (optional, hand-authored) — add Kiro
steering files here if needed``.
