---
'@ai-plugin-marketplace/core': patch
---

Anchor the Cursor controller-shim invocation to `${CLAUDE_PLUGIN_ROOT:-.}` instead of a cwd-relative
path. The 0.7.0 transform emitted gating hook commands as `node ./hooks/cursor-shim.mjs …`, which
assumed Cursor runs plugin hook commands with cwd = plugin root — an assumption Cursor does not
guarantee. Because shimmed entries set `failClosed: true`, a shim path that failed to resolve did
not merely disable the gate: `node` exited "Cannot find module" and **every gated tool call was
denied** for that plugin under Cursor.

The emitted command is now
`node "${CLAUDE_PLUGIN_ROOT:-.}/hooks/cursor-shim.mjs" <event> -- '<handler>'` (double-quoted, so a
plugin root containing spaces survives shell expansion). The `:-.` fallback matters because Cursor's
behavior differs by consumption layout: for an **installed plugin**, `${CLAUDE_PLUGIN_ROOT}` is set
to the plugin's install path (confirmed only by Cursor staff forum posts, not the official docs), so
the invocation anchors there regardless of cwd; for **project-level/colocated** hooks (a project's
own `.cursor/hooks.json`), Cursor does not set the variable at all — verified empirically against a
real `cursor-agent` build — so an unconditional `${CLAUDE_PLUGIN_ROOT}` anchor would expand to an
empty string and, combined with `failClosed: true`, deny every gated call. The `.` fallback resolves
relative to cwd (project root for project-level hooks), preserving the previously-working colocated
behavior.

The enforcement UAT now covers both layouts explicitly: a project-level/colocated scenario with
`CLAUDE_PLUGIN_ROOT` deleted from the spawn environment, and an installed-plugin scenario with the
hook cwd and the shim directory deliberately different and `CLAUDE_PLUGIN_ROOT` set — the case the
original workspace-colocated UAT could not detect. (#56)
