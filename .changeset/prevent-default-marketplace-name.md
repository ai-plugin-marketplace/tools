---
'@ai-plugin-marketplace/core': minor
'@ai-plugin-marketplace/cli': minor
---

Guard against duplicate marketplace names that collide on install, and give `aipm init` a distinct
marketplace name by default.

Two marketplaces registered under the same `name` collide on install: the later one shadows and
strands the earlier one's plugins. The template historically shipped `marketplace.name =
"ai-plugin-marketplace"` (the upstream's own name), so forks that never renamed it collided with
upstream. These two changes make that failure mode hard to fall into.

- **`aipm validate` warns on a default/placeholder marketplace name.** A new soft (warning-only)
  `default-marketplace-name` finding fires when the repo's effective marketplace `name` is a known
  placeholder (`ai-plugin-marketplace`, `my-ai-plugins`) or its `owner.name` is a placeholder
  (`AI Plugin Marketplace Template`, `Your Name`). The effective identity is read from
  `aipm.workspace.ts` when present, otherwise from a committed repo-root registry's top-level
  `name`/`owner.name`; when no marketplace metadata is declared, nothing is emitted. The finding is
  always soft — it never fails `aipm validate` — and includes a hint to rename to a unique value
  (convention `"<your-handle>-ai-plugins"`).

- **`aipm init --name <name>` and a distinct default marketplace name.** `aipm init` now writes a
  named marketplace into both repo-root registries
  (`{ "name", "owner": { "name" }, "plugins": [] }`) instead of a nameless `{ "plugins": [] }`. The
  marketplace name defaults to `${USER}-ai-plugins` (falling back to the `my-ai-plugins` placeholder
  when `$USER` is unset, which `aipm validate` then flags as a nudge to set a real name) and can be
  overridden with `aipm init --name <name>`. A new `InitOptions.marketplaceName` carries the
  resolved name; the default is resolved at the I/O boundary so the file-templating layer stays a
  pure function of its inputs.
