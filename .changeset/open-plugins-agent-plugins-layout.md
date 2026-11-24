---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

The `open-plugins` target now follows the Agent Plugins 1.0.0 package layout.

- The manifest is the plugin root's `plugin.json` instead of `.plugin/plugin.json`, and must carry `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`. `aipm scaffold` writes it there, and envelope adherence, name consistency and version consistency read it there. A plugin that declares `open-plugins` and still has only `.plugin/plugin.json` now fails validation until the file is moved.
- MCP configuration for `open-plugins` is the plugin root's `mcp.json`. That file is now shared by `kiro` and `open-plugins`, so either target allows it. `.mcp.json` is no longer accepted on behalf of `open-plugins`, since Agent Plugins hosts do not read it.
- `metadata-dir-isolation` is no longer reported. The code stays in `FindingCode` for compatibility.
- `FindingCode` gains the normalizer's skill-audience and source-reading codes (`skill-audience-invalid`, `skill-audience-omitted`, `skill-audience-widened`, `skill-audience-reduced`, `skill-audience-unenforced`, `skill-audience-conflict`, `skill-audience-prefix-invalid`, `skill-name-duplicate`, `skill-location-unsupported`, `source-unreadable`), so every normalizer finding is a valid `Finding`. Consumers that switch exhaustively over `FindingCode` need to handle them.

To migrate a plugin, move `.plugin/plugin.json` to `plugin.json`, replace `schemaVersion` with the `$schema` value above, and delete the empty `.plugin/` directory.
