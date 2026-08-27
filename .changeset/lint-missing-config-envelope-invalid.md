---
'@ai-plugin-marketplace/core': patch
---

Fix `aipm lint` staying silent for a plugin whose `aipm.config.ts` cannot be resolved — cases
`aipm validate` (hard `envelope-invalid`) and `aipm build` (thrown `ConfigLoadError`) already
caught. The `schema/envelope-shape` rule now fires for every envelope-load failure, not only a
schema violation: a plugin-shaped directory missing `aipm.config.ts`, and a config file that is
present but cannot be imported (syntax error, no usable default export). Both emit the same
`envelope-invalid`-backed, `error`-severity diagnostic `validate` reports for the identical tree,
carrying the config loader's own message verbatim, so the three surfaces agree instead of `lint`
reporting a clean bill of health for a broken plugin.
