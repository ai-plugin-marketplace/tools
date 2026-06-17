---
'@ai-plugin-marketplace/core': patch
---

Accept a relative `./*.json` path string for `mcpServers` in the Claude and Cursor plugin manifest schemas (a union with the existing inline-record form), matching the Codex schema and the `hooks` field. Previously Claude/Cursor manifests that referenced their MCP config by path (e.g. `"mcpServers": "./.mcp.json"`) were rejected with `schema-invalid` even though that is the form Claude Code installs from.
