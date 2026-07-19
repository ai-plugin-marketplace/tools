---
'@ai-plugin-marketplace/core': patch
---

Fix `aipm lint` staying silent for a plugin-shaped directory missing `aipm.config.ts` — a case
`aipm validate` (hard `envelope-invalid`) and `aipm build` (thrown `ConfigLoadError`) already
caught. The `schema/envelope-shape` rule now also fires when the config file is absent, emitting
the same `envelope-invalid`-backed, `error`-severity diagnostic `validate` reports for the
identical tree, so the three surfaces agree instead of `lint` reporting a clean bill of health for
a broken plugin.
