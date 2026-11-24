---
'@ai-plugin-marketplace/core': patch
---

Host-specific schemas, validators, hook transforms, scaffolds and bundlers now come from the new `@ai-plugin-marketplace/normalizer` package instead of living inside `core`. Public API and generated output are unchanged.

Kiro `mcp.json` validation now follows Kiro's MCP configuration reference: a server is either local (`command`, with `args` and `env`) or remote (`url`, with `headers`, `env` and `oauth`), and both kinds accept `disabled`, `autoApprove`, `disabledTools`, `timeout` and `timeoutMs`. Remote servers and these options used to be reported as `schema-invalid`. A server that sets both `command` and `url` is still rejected, and so are `$schema` and a per-server `type`.
