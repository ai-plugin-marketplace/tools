---
'@ai-plugin-marketplace/core': patch
---

Anchor the Cursor controller-shim invocation to `${CLAUDE_PLUGIN_ROOT}` instead of a cwd-relative
path. The 0.7.0 transform emitted gating hook commands as `node ./hooks/cursor-shim.mjs …`, which
assumed Cursor runs plugin hook commands with cwd = plugin root — an assumption Cursor does not
guarantee (its own guidance is to use `${CLAUDE_PLUGIN_ROOT}`). Because shimmed entries set
`failClosed: true`, a shim path that failed to resolve did not merely disable the gate: `node`
exited "Cannot find module" and **every gated tool call was denied** for that plugin under Cursor.

The emitted command is now `node "${CLAUDE_PLUGIN_ROOT}/hooks/cursor-shim.mjs" <event> -- '<handler>'`
(double-quoted, so a plugin root containing spaces survives shell expansion), matching the
absolute-path convention every other emitted command already follows. The enforcement UAT now also
covers an installed-plugin layout where the hook cwd and the shim directory differ — the case the
original workspace-colocated UAT could not detect. (#56)
