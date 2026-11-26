---
'@ai-plugin-marketplace/core': patch
'@ai-plugin-marketplace/cli': patch
---

Resolve CLI plugin arguments and scaffold destinations using the configured or default plugins root. Use the plugin's real directory and owning repo for discovery, dist output, and marketplace registration. Keep the core `checkSupport` and `addTarget` APIs path-based by default, with opt-in name lookup.
