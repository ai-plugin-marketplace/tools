---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Build a plugin's skill audience for each target. A skill can state who may invoke it (`audience: user | agent | both`, and `audience-fallback: widen`) in its `SKILL.md` frontmatter, and `aipm build` now delivers that per target.

- A target whose form of the plugin differs from the authored directory gets its own tree at `dist/<target>/<plugin>/`, and that target's registry entry points at it. Gemini and Kiro have the differences applied to the bundle they already get. Vercel Skills installs from the authored source, so nothing is generated for it and a restriction it cannot honour is reported as a warning. A plugin that states no audience builds exactly as before.
- `aipm build` prints, for each such plugin, where each target's form is and how each skill's audience is delivered there.
- New findings, reported by `validate`, `lint` (rule `portability/host-projection`) and `build`: `skill-audience-invalid`, `skill-audience-omitted`, `skill-audience-widened`, `skill-audience-reduced`, `skill-audience-unenforced`, `skill-audience-conflict`, `skill-audience-prefix-invalid`, `skill-name-duplicate`, `skill-location-unsupported` and `source-unreadable`. A hard finding about the source stops every target of that plugin; a hard finding about one target stops that target, and the plugin is left out of its registry.
- `BuildResult` gains `hosts`, one `HostBuildReport` per declared target.
- In a repository that writes its registries by hand, `marketplace-registration` expects an entry to point at `./dist/<target>/<plugin>` when the build generates that tree.
- The freshness check compares a link inside a generated tree as a link instead of failing on one that names a directory.
