---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

The `open-plugins` target now follows the Agent Plugins 1.0.0 package layout.

- The manifest is the plugin root's `plugin.json` instead of `.plugin/plugin.json`, and must carry `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`. `aipm scaffold` writes it there, and envelope adherence, name consistency and version consistency read it there. A plugin that declares `open-plugins` and still has only `.plugin/plugin.json` now fails validation until the file is moved.
- MCP configuration for `open-plugins` is the plugin root's `mcp.json`, with `"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"` and a `type` on each server. Declaring either `kiro` or `open-plugins` now allows a root `mcp.json`. `.mcp.json` is no longer accepted on behalf of `open-plugins`, since Agent Plugins hosts do not read it: a plugin that declares `open-plugins` but none of `claude`, `codex` or `cursor`, and still has `.mcp.json`, now fails `envelope-adherence`. Alongside one of those native targets, `.mcp.json` stays valid, but Open Plugins hosts ignore it.
- A plugin with MCP servers can't serve `kiro` and `open-plugins` together yet. Kiro's `mcp.json` rejects `$schema` and per-server `type`, which Agent Plugins requires, so one root `mcp.json` can't satisfy both: an Agent Plugins-shaped file fails Kiro's schema, and a Kiro-shaped file leaves Open Plugins hosts with no MCP servers. Declare one of the two for such a plugin. Plugins without MCP servers are unaffected.
- A leftover `.plugin/` directory is reported as a soft `envelope-adherence` finding, and the missing-manifest finding says to move `.plugin/plugin.json` when that file exists.
- `metadata-dir-isolation` is no longer reported. The code stays in `FindingCode` for compatibility.
- `FindingCode` gains the normalizer's skill-audience and source-reading codes (`skill-audience-invalid`, `skill-audience-omitted`, `skill-audience-widened`, `skill-audience-reduced`, `skill-audience-unenforced`, `skill-audience-conflict`, `skill-audience-prefix-invalid`, `skill-name-duplicate`, `skill-location-unsupported`, `source-unreadable`), so every normalizer finding is a valid `Finding`. Consumers that switch exhaustively over `FindingCode` need to handle them.

To migrate an `open-plugins` plugin:

1. Move `.plugin/plugin.json` to `plugin.json`, replace `schemaVersion` with the manifest `$schema` value above, and delete the empty `.plugin/` directory.
2. If the plugin has MCP servers in `.mcp.json`, move them to `mcp.json`, add `"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"`, and give each server a `type` (for example `"stdio"`). Keep `.mcp.json` as well if the plugin also declares `claude`, `codex` or `cursor`.
