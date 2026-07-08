---
'@ai-plugin-marketplace/core': minor
---

Add Open Plugins as a 7th host target (`open-plugins`).

Open Plugins ([open-plugins.com](https://open-plugins.com), v1.0.0) is a vendor-neutral external
standard for the on-disk shape of an AI-assistant plugin. Declaring `'open-plugins'` in a plugin's
envelope now emits an Open-Plugins-conformant `.plugin/plugin.json` manifest and a repo-root
`marketplace.json` registry (the 4th generated registry, at Open Plugins lookup position 1),
projected from the same authored source that feeds every other target.

The target validates the manifest against the Open Plugins name grammar and component-path rules
(each path must be `./`-relative with no `..`), checks that declared component paths resolve on
disk, and enforces metadata-directory isolation via a new hard `metadata-dir-isolation` finding
(the `.plugin/` directory must contain only `plugin.json`). Adds `'open-plugins'` to the `TargetId`
union and `'metadata-dir-isolation'` to the `FindingCode` union (both additive).

The repo-root `marketplace.json` is protected by the generated-root collision guard: a pre-existing
`marketplace.json` the toolkit did not generate raises a hard `root-artifact-collision` and is never
overwritten or orphan-removed.
